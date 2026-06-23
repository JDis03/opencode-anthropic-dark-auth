/**
 * Account storage management
 * Stores accounts in ~/.config/opencode/dark-auth-accounts.json
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Account, AccountStorage } from "./types.js";

/**
 * Log to file for debugging
 */
export function logToFile(message: string, data?: any): void {
  const logPath = join(homedir(), ".local", "share", "opencode", "dark-auth.log");
  const timestamp = new Date().toISOString();
  const logLine = data 
    ? `[${timestamp}] ${message} ${JSON.stringify(data)}\n`
    : `[${timestamp}] ${message}\n`;
  
  try {
    appendFileSync(logPath, logLine, "utf-8");
  } catch {
    // Ignore logging errors
  }
}

const DEFAULT_STORAGE: AccountStorage = {
  version: 1,
  accounts: [],
  activeAccountId: null,
};

/**
 * Get storage file path
 */
export function getStoragePath(): string {
  return join(homedir(), ".config", "opencode", "dark-auth-accounts.json");
}

/**
 * Get OpenCode auth.json path
 */
export function getAuthJsonPath(): string {
  return join(homedir(), ".local", "share", "opencode", "auth.json");
}

/**
 * Get Claude Code credentials file path
 */
export function getClaudeCredentialsPath(): string {
  return join(homedir(), ".claude", ".credentials.json");
}

/**
 * Import account from Claude Code's .credentials.json
 */
export function importFromClaudeCode(): Account | null {
  const credPath = getClaudeCredentialsPath();
  
  if (!existsSync(credPath)) {
    logToFile("[import] Claude Code credentials file does not exist");
    return null;
  }

  try {
    const raw = readFileSync(credPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
        subscriptionType?: string;
      };
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
      subscriptionType?: string;
    };

    // Try wrapped format first (claudeAiOauth)
    const creds = parsed.claudeAiOauth ?? parsed;

    if (
      typeof creds.accessToken !== "string" ||
      typeof creds.refreshToken !== "string" ||
      typeof creds.expiresAt !== "number"
    ) {
      logToFile("[import] Invalid Claude Code credentials format", {
        hasAccessToken: typeof creds.accessToken === "string",
        hasRefreshToken: typeof creds.refreshToken === "string",
        hasExpiry: typeof creds.expiresAt === "number",
      });
      return null;
    }

    const label = creds.subscriptionType
      ? `Claude ${creds.subscriptionType.charAt(0).toUpperCase()}${creds.subscriptionType.slice(1)}`
      : "Claude Code";

    logToFile("[import] Successfully imported from Claude Code", {
      label,
      expires: creds.expiresAt,
    });

    return {
      id: randomUUID(),
      label,
      credentials: {
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAt: creds.expiresAt,
      },
      enabled: true,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
  } catch (err) {
    logToFile("[import] Failed to parse Claude Code credentials", { error: String(err) });
    return null;
  }
}

/**
 * Import account from OpenCode's auth.json (first-time migration)
 * Only imports if credentials exist and are valid OAuth tokens
 */
export function importFromAuthJson(): Account | null {
  const authPath = getAuthJsonPath();
  
  if (!existsSync(authPath)) {
    logToFile("[import] auth.json does not exist");
    return null;
  }

  try {
    const raw = readFileSync(authPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      anthropic?: {
        type?: string;
        refresh?: string;
        access?: string;
        expires?: number;
      };
    };

    const anthropic = parsed.anthropic;
    if (!anthropic || anthropic.type !== "oauth" || !anthropic.refresh) {
      logToFile("[import] No valid OAuth credentials in auth.json", { 
        hasAnthropicKey: !!anthropic,
        type: anthropic?.type,
        hasRefresh: !!anthropic?.refresh,
      });
      return null;
    }

    logToFile("[import] Found OAuth credentials in auth.json", {
      hasAccess: !!anthropic.access,
      expires: anthropic.expires,
    });

    return {
      id: randomUUID(),
      label: "Imported from OpenCode",
      credentials: {
        accessToken: anthropic.access || "",
        refreshToken: anthropic.refresh,
        expiresAt: anthropic.expires || Date.now() + 3600000,
      },
      enabled: true,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
  } catch (err) {
    logToFile("[import] Failed to parse auth.json", { error: String(err) });
    return null;
  }
}

/**
 * Load accounts from disk
 */
export function loadAccounts(): AccountStorage {
  const path = getStoragePath();
  
  if (!existsSync(path)) {
    return { ...DEFAULT_STORAGE };
  }

  try {
    const content = readFileSync(path, "utf-8");
    const data = JSON.parse(content) as AccountStorage;
    
    // Validate structure
    if (!data.version || !Array.isArray(data.accounts)) {
      console.warn("[dark-auth] Invalid storage format, resetting");
      return { ...DEFAULT_STORAGE };
    }

    // Clean up expired rate limits
    data.accounts = data.accounts.map((account) => {
      if (account.rateLimitedUntil && account.rateLimitedUntil < Date.now()) {
        const { rateLimitedUntil, ...rest } = account;
        return rest as Account;
      }
      return account;
    });

    return data;
  } catch (error) {
    console.error("[dark-auth] Failed to load accounts:", error);
    return { ...DEFAULT_STORAGE };
  }
}

/**
 * Save accounts to disk atomically
 */
export function saveAccounts(storage: AccountStorage): void {
  const path = getStoragePath();
  const dir = join(homedir(), ".config", "opencode");

  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Atomic write: temp file → rename
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(storage, null, 2) + "\n";

  try {
    writeFileSync(tempPath, content, { encoding: "utf-8", mode: 0o600 });
    renameSync(tempPath, path);
  } catch (error) {
    console.error("[dark-auth] Failed to save accounts:", error);
    throw error;
  }
}

/**
 * Add or update an account
 */
export function upsertAccount(account: Account): void {
  const storage = loadAccounts();
  
  const existingIndex = storage.accounts.findIndex((a) => a.id === account.id);
  
  if (existingIndex >= 0) {
    storage.accounts[existingIndex] = account;
  } else {
    storage.accounts.push(account);
  }

  // Set as active if it's the first account
  if (!storage.activeAccountId) {
    storage.activeAccountId = account.id;
  }

  saveAccounts(storage);
}

/**
 * Get active account
 */
export function getActiveAccount(): Account | null {
  const storage = loadAccounts();
  
  if (!storage.activeAccountId) {
    return storage.accounts[0] || null;
  }

  return storage.accounts.find((a) => a.id === storage.activeAccountId) || null;
}

/**
 * Set active account by ID
 */
export function setActiveAccount(accountId: string): void {
  const storage = loadAccounts();
  
  const account = storage.accounts.find((a) => a.id === accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found`);
  }

  storage.activeAccountId = accountId;
  saveAccounts(storage);
}
