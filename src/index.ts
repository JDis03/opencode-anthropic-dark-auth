/**
 * opencode-anthropic-dark-auth
 * Anthropic OAuth plugin for OpenCode with multi-account support
 * Original implementation — not a fork. Own architecture, own fixes.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Account } from "./types.js";
import { generatePKCE, buildAuthorizeURL, exchangeCode } from "./oauth.js";
import {
  loadAccounts,
  saveAccounts,
  upsertAccount,
  getActiveAccount,
  setActiveAccount,
  getStoragePath,
} from "./storage.js";
import {
  getCachedCredentials,
  refreshIfNeeded,
  invalidateCache,
  handleRateLimit,
  getShortestWait,
  updateConfig,
} from "./accounts.js";

const PROACTIVE_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
const PROACTIVE_REFRESH_THRESHOLD = 60 * 60 * 1000; // 1 hour

/**
 * Sync credentials to OpenCode's auth.json so the built-in provider
 * can also read them if needed.
 */
function syncAuthJson(credentials: { accessToken: string; refreshToken: string; expiresAt: number }): void {
  const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
  const dir = join(homedir(), ".local", "share", "opencode");
  
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  
  let auth: Record<string, any> = {};
  if (existsSync(authPath)) {
    try {
      auth = JSON.parse(readFileSync(authPath, "utf-8"));
    } catch { /* malformed, start fresh */ }
  }
  
  auth.anthropic = {
    type: "oauth",
    access: credentials.accessToken,
    refresh: credentials.refreshToken,
    expires: credentials.expiresAt,
  };
  
  writeFileSync(authPath, JSON.stringify(auth, null, 2), { encoding: "utf-8", mode: 0o600 });
  chmodSync(authPath, 0o600);
}

/**
 * OpenCode plugin export
 */
export default async function plugin() {
  console.log("[dark-auth] Initializing plugin");

  const storage = loadAccounts();
  console.log(`[dark-auth] Loaded ${storage.accounts.length} account(s)`);

  // If no accounts, return login-only config
  if (storage.accounts.length === 0) {
    console.log("[dark-auth] No accounts found. Use login method to authenticate.");
    return {
      auth: {
        provider: "anthropic",
        async loader() {
          return {};
        },
        methods: [
          {
            type: "oauth",
            label: "Login with Claude Pro/Max",
            async authorize() {
              const pkce = generatePKCE();
              const url = buildAuthorizeURL(pkce);

              return {
                url,
                instructions: "Open the URL above in your browser, authorize, and paste the code here:",
                method: "code" as const,
                async callback(authorizationCode: string) {
                  const credentials = await exchangeCode(
                    authorizationCode,
                    pkce.verifier
                  );

                  if (!credentials) {
                    return { type: "failed" as const };
                  }

                  const account: Account = {
                    id: randomUUID(),
                    label: "Claude Pro/Max",
                    credentials,
                    enabled: true,
                    createdAt: Date.now(),
                    lastUsedAt: Date.now(),
                  };

                  upsertAccount(account);
                  syncAuthJson(credentials);

                  return {
                    type: "success" as const,
                    provider: "anthropic" as const,
                    access: credentials.accessToken,
                    refresh: credentials.refreshToken,
                    expires: credentials.expiresAt,
                  };
                },
              };
            },
          },
        ],
      },
    };
  }

  // === Has accounts — start proactive refresh timer ===
  // Every 5 minutes, check if any account's token is expiring within 1 hour.
  // If so, refresh it proactively — our fix from the opencode-claude-auth work.
  const refreshTimer = setInterval(async () => {
    try {
      const current = getActiveAccount();
      if (!current) return;

      const expiresIn = current.credentials.expiresAt - Date.now();

      if (expiresIn < PROACTIVE_REFRESH_THRESHOLD) {
        console.log(
          `[dark-auth] Proactive refresh: token expires in ${Math.round(expiresIn / 60000)}min`
        );
        const refreshed = await refreshIfNeeded(current, true);
        if (refreshed) {
          syncAuthJson(refreshed);
          console.log("[dark-auth] Proactive refresh successful");
        }
      }
    } catch {
      // Non-fatal: timer keeps running
    }
  }, PROACTIVE_REFRESH_INTERVAL);

  // Allow Node/Bun to exit even if timer is running
  refreshTimer.unref();

  // === Provide auth loader with all our fixes ===
  return {
    auth: {
      provider: "anthropic",
      async loader(getAuth: () => Promise<any>, provider: any) {
        console.log("[dark-auth] Auth loader called");

        // Set model costs to 0 (Pro/Max plans have unlimited usage)
        for (const model of Object.values(provider.models) as any[]) {
          model.cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          };
        }

        return {
          apiKey: "",
          baseURL: "https://api.anthropic.com/v1",
          async fetch(input: string | URL | Request, init?: RequestInit) {
            const account = getActiveAccount();

            if (!account) {
              throw new Error(
                "[dark-auth] No active account. Run login to authenticate."
              );
            }

            // Get credentials with proactive refresh
            const credentials = await getCachedCredentials(account.id);

            if (!credentials) {
              throw new Error(
                "[dark-auth] Failed to get credentials. Token might be expired."
              );
            }

            // Build request with auth header
            const headers = new Headers(init?.headers);
            headers.set("x-api-key", credentials.accessToken);
            headers.set("anthropic-version", "2023-06-01");

            // Make the request
            let response = await fetch(input, {
              ...init,
              headers,
            });

            // Handle 401: token invalidated (e.g. running `claude` in terminal
            // revoked our refresh token). Invalidate cache and force refresh.
            // Our fix from the opencode-claude-auth work.
            if (response.status === 401) {
              console.log("[dark-auth] 401 detected, forcing token refresh");

              invalidateCache(account.id);
              const refreshed = await refreshIfNeeded(account, true);

              if (refreshed) {
                syncAuthJson(refreshed);
                headers.set("x-api-key", refreshed.accessToken);
                response = await fetch(input, {
                  ...init,
                  headers,
                });
              } else {
                throw new Error(
                  "[dark-auth] Token refresh failed after 401. Run `claude` to re-authenticate."
                );
              }
            }

            // Handle 429: rate limited. Our fix from the opencode-claude-auth work:
            // if retry-after > 30s, throw immediately instead of "Retrying in 25201s".
            if (response.status === 429) {
              const retryAfter = response.headers.get("retry-after");
              const retryMs = retryAfter
                ? parseInt(retryAfter, 10) * 1000
                : 60_000;

              console.log(
                `[dark-auth] Rate limited (retry after ${Math.round(retryMs / 1000)}s)`
              );

              // Long retry-after (>30s): throw clear error, no "Retrying in Xs"
              if (retryMs > 30_000) {
                const waitMins = Math.ceil(retryMs / 60000);
                throw new Error(
                  `[dark-auth] Anthropic rate limit exceeded. Resets in ~${waitMins}min. ` +
                  (storage.accounts.length > 1
                    ? "Auto-switching to next account..."
                    : "Add more accounts for automatic rotation.")
                );
              }

              // Short retry: try switching to next available account
              const nextAccount = handleRateLimit(account.id, retryMs);

              if (nextAccount) {
                const nextCreds = await getCachedCredentials(nextAccount.id);
                if (nextCreds) {
                  console.log("[dark-auth] Switching to next account");
                  headers.set("x-api-key", nextCreds.accessToken);
                  response = await fetch(input, {
                    ...init,
                    headers,
                  });
                }
              }
            }

            return response;
          },
        };
      },
      methods: [
        {
          type: "oauth",
          label: "Manage Accounts",
          async authorize() {
            const accounts = loadAccounts();

            if (accounts.accounts.length === 0) {
              return {
                url: "",
                instructions: "No accounts configured. Re-run to add accounts.",
                method: "auto" as const,
                async callback() {
                  return { type: "failed" as const };
                },
              };
            }

            return {
              url: "",
              instructions: `Active: ${accounts.activeAccountId || "none"}\nTotal: ${accounts.accounts.length}\nStorage: ${getStoragePath()}`,
              method: "auto" as const,
              async callback() {
                return { type: "success" as const };
              },
            };
          },
        },
      ],
    },
  };
}

