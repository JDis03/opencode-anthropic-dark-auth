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
  importFromClaudeCode,
  importFromAuthJson,
  logToFile,
} from "./storage.js";
import { transformBody, transformResponseStream } from "./transforms";
import {
  getCachedCredentials,
  refreshIfNeeded,
  invalidateCache,
  handleRateLimit,
} from "./accounts.js";

const PROACTIVE_REFRESH_INTERVAL = 5 * 60 * 1000;
const PROACTIVE_REFRESH_THRESHOLD = 60 * 60 * 1000;

// Stable per-process session ID, matching Claude Code's X-Claude-Code-Session-Id
const sessionId = randomUUID();

export default async function darkAuthPlugin({ client }: { client: any }) {
  logToFile("[dark-auth] Initializing plugin");
  console.log("[dark-auth] Initializing plugin");

  let storage = loadAccounts();
  logToFile(`[dark-auth] Loaded ${storage.accounts.length} account(s)`);
  console.log(`[dark-auth] Loaded ${storage.accounts.length} account(s)`);

  // ── First-time migration: import from Claude Code or OpenCode auth ──
  if (storage.accounts.length === 0) {
    logToFile("[dark-auth] No accounts found, attempting import");
    
    // Try Claude Code first (official source)
    let imported = importFromClaudeCode();
    if (imported) {
      logToFile("[dark-auth] Successfully imported from Claude Code", {
        label: imported.label,
        expiresAt: imported.credentials.expiresAt,
      });
      upsertAccount(imported);
      storage = loadAccounts();
      console.log("[dark-auth] Imported account from Claude Code");
    } else {
      // Fallback to OpenCode auth.json
      imported = importFromAuthJson();
      if (imported) {
        logToFile("[dark-auth] Successfully imported from OpenCode auth.json", {
          label: imported.label,
          expiresAt: imported.credentials.expiresAt,
        });
        upsertAccount(imported);
        storage = loadAccounts();
        console.log("[dark-auth] Imported account from OpenCode auth.json");
      } else {
        logToFile("[dark-auth] No credentials found in Claude Code or OpenCode");
      }
    }
  }

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

            // Transform URL: add ?beta=true for /v1/messages (matching fix plugin)
            const url = new URL(
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : (input as Request).url
            );
            if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) {
              url.searchParams.set("beta", "true");
            }
            const requestUrl = typeof input === "string" ? url.toString() : url;

            // Build request headers (matching fix plugin exactly)
            const headers = new Headers(init?.headers);
            
            // Merge anthropic-beta values
            const incomingBeta = headers.get("anthropic-beta") ?? "";
            const baseBetas = [
              "oauth-2025-04-20",
              "files-api-2025-04-14",
              "prompt-caching-scope-2026-01-05",
              "extended-cache-ttl-2025-04-11"
            ];
            const mergedBetas = [
              ...new Set([
                ...baseBetas,
                ...incomingBeta.split(",").map((b) => b.trim()).filter(Boolean),
              ]),
            ];

            headers.delete("x-api-key");
            headers.set("authorization", `Bearer ${credentials.accessToken}`);
            headers.set("anthropic-version", "2023-06-01");
            headers.set("anthropic-beta", mergedBetas.join(","));
            headers.set("anthropic-dangerous-direct-browser-access", "true");
            headers.set("x-app", "cli");
            headers.set("user-agent", `claude-cli/2.1.159 (external, sdk-cli)`);
            headers.set("x-client-request-id", randomUUID());
            headers.set("X-Claude-Code-Session-Id", sessionId);
            
            // Stainless headers (matching fix plugin)
            const stainlessHeaders = {
              "x-stainless-arch": process.arch === "arm64" ? "arm64" : process.arch,
              "x-stainless-lang": "js",
              "x-stainless-os": process.platform === "darwin" ? "MacOS" : process.platform,
              "x-stainless-package-version": "0.81.0",
              "x-stainless-retry-count": "0",
              "x-stainless-runtime": "node",
              "x-stainless-runtime-version": process.version,
              "x-stainless-timeout": "600",
            };
            for (const [key, value] of Object.entries(stainlessHeaders)) {
              if (!headers.has(key)) headers.set(key, value);
            }

            // Transform body (critical for OAuth - adds billing header, splits system entries)
            const transformedBody = transformBody(init?.body);

            // ── Retry loop (matching fix plugin behavior) ──
            const MAX_RETRIES = 3;
            const MAX_RETRY_DELAY_MS = 30_000;
            let response: Response | null = null;

            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
              response = await fetch(requestUrl, { ...init, body: transformedBody, headers });

              // Log non-200 responses for debugging
              if (response.status !== 200) {
                const cloned = response.clone();
                const body = await cloned.text().catch(() => "");
                const logMsg = `Response ${response.status} (attempt ${attempt + 1}): ${body.substring(0, 500)}`;
                logToFile(`[dark-auth] ${logMsg}`);
                console.log(`[dark-auth] ${logMsg}`);
              }

              // ── 401 handler ──
              if (response.status === 401 && attempt < MAX_RETRIES - 1) {
                logToFile("[dark-auth] 401 detected, forcing token refresh");
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
                  continue; // Retry with new token
                } else {
                  throw new Error(
                    "[dark-auth] Token refresh failed after 401. Run login to re-authenticate.",
                  );
                }
              }

              // ── 429 handler ──
              if ((response.status === 429 || response.status === 529) && attempt < MAX_RETRIES - 1) {
                const retryAfter = response.headers.get("retry-after");
                const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN;
                const delayMs = Number.isNaN(parsed) ? (attempt + 1) * 2000 : parsed * 1000;

                const msg = `Rate limited (retry after ${Math.round(delayMs / 1000)}s, attempt ${attempt + 1})`;
                logToFile(`[dark-auth] ${msg}`, { retryAfter, delayMs });
                console.log(`[dark-auth] ${msg}`);

                // If delay exceeds cap, throw error immediately
                if (delayMs > MAX_RETRY_DELAY_MS) {
                  const waitHours = Math.ceil(delayMs / 3600000);
                  const waitMsg = waitHours > 1
                    ? `Resets in ~${waitHours} hours.`
                    : `Resets in ~${Math.ceil(delayMs / 60000)} minutes.`;
                  
                  throw new Error(
                    `[dark-auth] Anthropic rate limit exceeded. ${waitMsg} ` +
                    (storage.accounts.length > 1
                      ? "Add more accounts for automatic rotation."
                      : "Run \`opencode auth login\` to add another account."),
                  );
                }

                // Wait and retry
                await new Promise((r) => setTimeout(r, delayMs));
                continue;
              }

              // Success or non-retryable error
              break;
            }

            // Transform response stream (strips tool prefix, handles SSE correctly)
            return transformResponseStream(response!);
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
