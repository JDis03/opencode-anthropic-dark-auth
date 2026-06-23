/**
 * opencode-anthropic-dark-auth
 * Anthropic OAuth plugin for OpenCode with multi-account support
 * Original implementation — not a fork. Own architecture, own fixes.
 *
 * Design: uses client.auth.set() to persist into OpenCode's internal store
 * so getAuth() returns oauth credentials. Our own storage handles multi-account
 * rotation; OpenCode's auth store acts as the "primary" account mirror.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Account } from "./types.js";
import { generatePKCE, buildAuthorizeURL, exchangeCode } from "./oauth.js";
import {
  loadAccounts,
  upsertAccount,
  getActiveAccount,
  getStoragePath,
} from "./storage.js";
import {
  getCachedCredentials,
  refreshIfNeeded,
  invalidateCache,
  handleRateLimit,
} from "./accounts.js";

const PROACTIVE_REFRESH_INTERVAL = 5 * 60 * 1000;
const PROACTIVE_REFRESH_THRESHOLD = 60 * 60 * 1000;

export default async function darkAuthPlugin({ client }: { client: any }) {
  console.log("[dark-auth] Initializing plugin");

  const storage = loadAccounts();
  console.log(`[dark-auth] Loaded ${storage.accounts.length} account(s)`);

  // ── Persist into OpenCode's internal auth store ──
  // This is what getAuth() reads from. Without this, OpenCode never knows
  // we have oauth credentials and falls back to API key prompt.

  async function persistOpenCodeAuth(
    refresh: string,
    access: string,
    expires: number,
  ) {
    try {
      await client.auth.set({
        path: { id: "anthropic" },
        body: { type: "oauth", refresh, access, expires },
      });
    } catch (err) {
      console.error("[dark-auth] Failed to persist OpenCode auth:", err);
    }
  }

  // ── Also sync to auth.json as backup ──

  function syncAuthJson(credentials: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }): void {
    const authDir = join(homedir(), ".local", "share", "opencode");
    const authPath = join(authDir, "auth.json");

    if (!existsSync(authDir)) {
      mkdirSync(authDir, { recursive: true, mode: 0o700 });
    }

    let auth: Record<string, any> = {};
    if (existsSync(authPath)) {
      try {
        auth = JSON.parse(readFileSync(authPath, "utf-8"));
      } catch {
        /* malformed, start fresh */
      }
    }

    auth.anthropic = {
      type: "oauth",
      access: credentials.accessToken,
      refresh: credentials.refreshToken,
      expires: credentials.expiresAt,
    };

    writeFileSync(authPath, JSON.stringify(auth, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    chmodSync(authPath, 0o600);
  }

  // ── Proactive refresh timer ──
  // Every 5 minutes, check if the active account's token is expiring
  // within 1 hour. If so, refresh it proactively.
  // Our fix from the opencode-claude-auth work.

  if (storage.accounts.length > 0) {
    const refreshTimer = setInterval(async () => {
      try {
        const current = getActiveAccount();
        if (!current) return;

        const expiresIn = current.credentials.expiresAt - Date.now();
        if (expiresIn < PROACTIVE_REFRESH_THRESHOLD) {
          console.log(
            `[dark-auth] Proactive refresh: token expires in ${Math.round(expiresIn / 60000)}min`,
          );
          const refreshed = await refreshIfNeeded(current, true);
          if (refreshed) {
            await persistOpenCodeAuth(
              refreshed.refreshToken,
              refreshed.accessToken,
              refreshed.expiresAt,
            );
            syncAuthJson(refreshed);
            console.log("[dark-auth] Proactive refresh successful");
          }
        }
      } catch {
        // Non-fatal: timer keeps running
      }
    }, PROACTIVE_REFRESH_INTERVAL);
    refreshTimer.unref();
  }

  // ── Boot: sync existing accounts to OpenCode auth store ──
  const active = getActiveAccount();
  if (active) {
    await persistOpenCodeAuth(
      active.credentials.refreshToken,
      active.credentials.accessToken,
      active.credentials.expiresAt,
    );
  }

  // ── Return auth configuration ──
  // Always return the full auth config — even with zero accounts.
  // The loader handles the "no auth" case by returning {} so OpenCode
  // falls through to showing auth methods.

  return {
    auth: {
      provider: "anthropic" as const,

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

        // Check if OpenCode knows about our OAuth credentials
        const auth = await getAuth();
        if (auth.type !== "oauth") {
          console.log("[dark-auth] No oauth credentials — showing auth methods");
          return {};
        }

        // We have oauth — return custom fetch with our fixes
        return {
          apiKey: "",
          baseURL: "https://api.anthropic.com/v1",

          async fetch(input: string | URL | Request, init?: RequestInit) {
            const account = getActiveAccount();

            if (!account) {
              throw new Error(
                "[dark-auth] No active account. Run login to authenticate.",
              );
            }

            // Get credentials with proactive refresh
            const credentials = await getCachedCredentials(account.id);
            if (!credentials) {
              throw new Error(
                "[dark-auth] Failed to get credentials. Token might be expired.",
              );
            }

            // Build request with auth header
            // OAuth tokens use Authorization: Bearer (NOT x-api-key)
            const headers = new Headers(init?.headers);
            headers.delete("x-api-key");
            headers.set("authorization", `Bearer ${credentials.accessToken}`);
            headers.set("anthropic-version", "2023-06-01");
            headers.set("anthropic-beta", "oauth-2025-04-20");
            headers.set("x-app", "cli");

            // Pre-flight rate limit check: if this account is already rate-limited,
            // try switching to another account before even making the request.
            const rateLimitUntil = account.rateLimitedUntil;
            if (rateLimitUntil && rateLimitUntil > Date.now()) {
              const remainingMs = rateLimitUntil - Date.now();
              console.log(
                `[dark-auth] Account rate-limited, ${Math.round(remainingMs / 60000)}min remaining`,
              );
              const fallback = handleRateLimit(account.id, remainingMs);
              if (fallback) {
                const fallbackCreds = await getCachedCredentials(fallback.id);
                if (fallbackCreds) {
                  console.log("[dark-auth] Pre-switching to fallback account");
                  headers.set("authorization", `Bearer ${fallbackCreds.accessToken}`);
                }
              }
            }

            // Make the request
            let response = await fetch(input, { ...init, headers });

            // ── 401 handler (our fix) ──
            // Token invalidated (e.g. running `claude` in terminal revoked
            // our refresh token). Invalidate cache, force refresh, retry once.
            if (response.status === 401) {
              console.log("[dark-auth] 401 detected, forcing token refresh");

              invalidateCache(account.id);
              const refreshed = await refreshIfNeeded(account, true);

              if (refreshed) {
                await persistOpenCodeAuth(
                  refreshed.refreshToken,
                  refreshed.accessToken,
                  refreshed.expiresAt,
                );
                syncAuthJson(refreshed);
                headers.set("authorization", `Bearer ${refreshed.accessToken}`);
                response = await fetch(input, { ...init, headers });
              } else {
                throw new Error(
                  "[dark-auth] Token refresh failed after 401. Run login to re-authenticate.",
                );
              }
            }

            // ── 429 handler (our fix) ──
            // Rate limited. If retry-after > 30s, return a non-retryable
            // response so OpenCode doesn't loop with "Retrying in 25201s".
            if (response.status === 429) {
              const retryAfter = response.headers.get("retry-after");
              const retryMs = retryAfter
                ? parseInt(retryAfter, 10) * 1000
                : 60_000;

              console.log(
                `[dark-auth] Rate limited (retry after ${Math.round(retryMs / 1000)}s)`,
              );

              // Always track the rate limit and try to switch accounts
              const nextAccount = handleRateLimit(account.id, retryMs);
              account.rateLimitedUntil = Date.now() + retryMs;

              // Long cooldown (>30s): return a non-retryable response.
              // OpenCode's retry.ts only retries 5xx or isRetryable errors.
              // Status 400 (Bad Request) is not retryable — this stops the loop.
              if (retryMs > 30_000) {
                const waitMins = Math.ceil(retryMs / 60000);

                // If we have another account, try it
                if (nextAccount) {
                  const nextCreds = await getCachedCredentials(nextAccount.id);
                  if (nextCreds) {
                    console.log("[dark-auth] Switching to next account (long cooldown)");
                    headers.set("authorization", `Bearer ${nextCreds.accessToken}`);
                    return fetch(input, { ...init, headers });
                  }
                }

                // No other account — return 400 (NOT 429) to prevent retry loop
                return new Response(
                  JSON.stringify({
                    type: "error",
                    error: {
                      type: "rate_limit_error",
                      message: `Rate limited. Resets in ~${waitMins}min. No other accounts available.`,
                    },
                  }),
                  {
                    status: 400,
                    statusText: "Rate Limited",
                    headers: { "content-type": "application/json" },
                  },
                );
              }

              // Short cooldown (≤30s): try next account if available
              if (nextAccount) {
                const nextCreds = await getCachedCredentials(nextAccount.id);
                if (nextCreds) {
                  console.log("[dark-auth] Switching to next account");
                  headers.set("authorization", `Bearer ${nextCreds.accessToken}`);
                  response = await fetch(input, { ...init, headers });
                }
              }
            }

            return response;
          },
        };
      },

      methods: [
        {
          type: "oauth" as const,
          label: "Login with Claude Pro/Max",
          async authorize() {
            const pkce = generatePKCE();
            const url = buildAuthorizeURL(pkce);

            return {
              url,
              instructions:
                "Open the URL above in your browser, authorize, and paste the code here:",
              method: "code" as const,

              async callback(authorizationCode: string) {
                const credentials = await exchangeCode(
                  authorizationCode,
                  pkce.verifier,
                );

                if (!credentials) {
                  return { type: "failed" as const };
                }

                // Save to our own multi-account storage
                const account: Account = {
                  id: randomUUID(),
                  label: "Claude Pro/Max",
                  credentials,
                  enabled: true,
                  createdAt: Date.now(),
                  lastUsedAt: Date.now(),
                };
                upsertAccount(account);

                // Persist into OpenCode's auth store (critical!)
                await persistOpenCodeAuth(
                  credentials.refreshToken,
                  credentials.accessToken,
                  credentials.expiresAt,
                );
                syncAuthJson(credentials);

                // Return success — OpenCode will store these
                return {
                  type: "success" as const,
                  access: credentials.accessToken,
                  refresh: credentials.refreshToken,
                  expires: credentials.expiresAt,
                };
              },
            };
          },
        },
        {
          type: "oauth" as const,
          label: "Manage Accounts",
          async authorize() {
            const accounts = loadAccounts();

            if (accounts.accounts.length === 0) {
              return {
                url: "",
                instructions: "No accounts configured. Run 'Login' to add an account.",
                method: "auto" as const,
                async callback() {
                  return { type: "failed" as const };
                },
              };
            }

            return {
              url: "",
              instructions:
                `Active: ${accounts.activeAccountId || "none"}\n` +
                `Total: ${accounts.accounts.length}\n` +
                `Storage: ${getStoragePath()}`,
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
