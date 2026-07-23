/**
 * Account management with proactive refresh and rate limit handling
 */

import type { Account, OAuthCredentials, PluginConfig } from "./types.js";
import { refreshToken } from "./oauth.js";
import {
  loadAccounts,
  saveAccounts,
  getActiveAccount,
  importFromClaudeCode,
  logToFile,
} from "./storage.js";

const DEFAULT_CONFIG: PluginConfig = {
  proactiveRefreshThresholdMs: 60 * 60 * 1000, // 1 hour
  maxRetryDelayMs: 30_000, // 30 seconds
  credentialsCacheTTL: 30_000, // 30 seconds
  logLevel: "info",
};

let config: PluginConfig = { ...DEFAULT_CONFIG };
let credentialsCache: Map<string, { credentials: OAuthCredentials; cachedAt: number }> = new Map();

/**
 * Update plugin configuration
 */
export function updateConfig(newConfig: Partial<PluginConfig>): void {
  config = { ...config, ...newConfig };
}

/**
 * Get credentials with caching
 */
export async function getCachedCredentials(
  accountId?: string
): Promise<OAuthCredentials | null> {
  const account = accountId
    ? loadAccounts().accounts.find((a) => a.id === accountId)
    : getActiveAccount();

  if (!account) {
    return null;
  }

  const now = Date.now();
  const cached = credentialsCache.get(account.id);

  // Check cache validity
  if (
    cached &&
    now - cached.cachedAt < config.credentialsCacheTTL &&
    cached.credentials.expiresAt > now + 60_000
  ) {
    return cached.credentials;
  }

  // Cache miss or expired - refresh if needed
  const credentials = await refreshIfNeeded(account);
  
  if (credentials) {
    credentialsCache.set(account.id, {
      credentials,
      cachedAt: now,
    });
  }

  return credentials;
}

/**
 * Refresh credentials if needed (proactive or reactive)
 */
export async function refreshIfNeeded(
  account: Account,
  force = false
): Promise<OAuthCredentials | null> {
  const now = Date.now();
  const expiresIn = account.credentials.expiresAt - now;

  // Proactive refresh: refresh if expiring within threshold
  // Or force refresh (e.g., after 401)
  const shouldRefresh = force || expiresIn < config.proactiveRefreshThresholdMs;

  if (!shouldRefresh) {
    return account.credentials;
  }

  console.log(
    `[dark-auth] Refreshing token for account ${account.id} (expires in ${Math.round(expiresIn / 60000)}min)`
  );

  // Attempt OAuth refresh
  const refreshed = await refreshToken(account.credentials.refreshToken);

  if (!refreshed) {
    console.error(`[dark-auth] Failed to refresh token for account ${account.id}`);

    // Our stored refresh token may have gone stale relative to Claude Code's
    // (e.g. the `claude` CLI rotated it independently in another session).
    // Re-import the current credentials from Claude Code's file and use
    // those instead of giving up outright.
    const imported = importFromClaudeCode();
    if (imported && imported.credentials.expiresAt > now) {
      console.log(
        `[dark-auth] Resynced stale credentials from Claude Code for account ${account.id}`
      );
      logToFile(
        `[dark-auth] Resynced stale credentials from Claude Code for account ${account.id}`
      );

      account.credentials = imported.credentials;
      account.lastUsedAt = now;

      const storage = loadAccounts();
      const index = storage.accounts.findIndex((a) => a.id === account.id);
      if (index >= 0) {
        storage.accounts[index] = account;
        saveAccounts(storage);
      }

      credentialsCache.delete(account.id);
      return imported.credentials;
    }

    logToFile(`[dark-auth] Resync from Claude Code unavailable or also stale for account ${account.id}`);
    return null;
  }

  // Update account with new credentials
  account.credentials = refreshed;
  account.lastUsedAt = now;

  // Persist to disk
  const storage = loadAccounts();
  const index = storage.accounts.findIndex((a) => a.id === account.id);
  if (index >= 0) {
    storage.accounts[index] = account;
    saveAccounts(storage);
  }

  // Invalidate cache so next call gets fresh credentials
  credentialsCache.delete(account.id);

  return refreshed;
}

/**
 * Invalidate credentials cache for an account
 */
export function invalidateCache(accountId?: string): void {
  if (accountId) {
    credentialsCache.delete(accountId);
  } else {
    credentialsCache.clear();
  }
}

/**
 * Handle rate limit by marking account and selecting next available
 */
export function handleRateLimit(
  accountId: string,
  retryAfterMs: number
): Account | null {
  const storage = loadAccounts();
  
  // Mark current account as rate limited
  const account = storage.accounts.find((a) => a.id === accountId);
  if (account) {
    account.rateLimitedUntil = Date.now() + retryAfterMs;
  }

  // Find next available account (enabled, not rate limited)
  const available = storage.accounts.filter(
    (a) =>
      a.id !== accountId &&
      a.enabled &&
      (!a.rateLimitedUntil || a.rateLimitedUntil < Date.now())
  );

  if (available.length === 0) {
    saveAccounts(storage);
    return null;
  }

  // Set first available as active
  storage.activeAccountId = available[0].id;
  saveAccounts(storage);

  return available[0];
}

/**
 * Get shortest wait time across all rate-limited accounts
 */
export function getShortestWait(): number | null {
  const storage = loadAccounts();
  const now = Date.now();

  let shortest = Infinity;

  for (const account of storage.accounts) {
    if (account.rateLimitedUntil && account.rateLimitedUntil > now) {
      shortest = Math.min(shortest, account.rateLimitedUntil - now);
    }
  }

  return Number.isFinite(shortest) ? shortest : null;
}
