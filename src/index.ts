/**
 * opencode-anthropic-dark-auth
 * Anthropic OAuth plugin for OpenCode with multi-account support
 */

import { randomUUID } from "node:crypto";
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
} from "./accounts.js";

// Track pending OAuth flows
const pendingOAuthFlows = new Map<string, { verifier: string; createdAt: number }>();

/**
 * OpenCode plugin export
 */
export default async function plugin() {
  console.log("[dark-auth] Initializing plugin");

  const storage = loadAccounts();
  console.log(`[dark-auth] Loaded ${storage.accounts.length} account(s)`);

  // If no accounts, return empty config (user needs to login)
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
              const flowId = randomUUID();

              pendingOAuthFlows.set(flowId, {
                verifier: pkce.verifier,
                createdAt: Date.now(),
              });

              return {
                url,
                instructions: "Open the URL above in your browser, authorize, and paste the code here:",
                method: "code" as const,
                async callback(authorizationCode: string) {
                  const flow = pendingOAuthFlows.get(flowId);
                  if (!flow) {
                    return { type: "failed" as const };
                  }

                  pendingOAuthFlows.delete(flowId);

                  const credentials = await exchangeCode(
                    authorizationCode,
                    flow.verifier
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

  // Has accounts - provide auth loader with custom fetch
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
          apiKey: "", // Not used, we provide custom fetch
          baseURL: "https://api.anthropic.com/v1",
          async fetch(input: string | URL | Request, init?: RequestInit) {
            const account = getActiveAccount();
            
            if (!account) {
              throw new Error(
                "[dark-auth] No active account. Run login to authenticate."
              );
            }

            // Get fresh credentials (with caching and proactive refresh)
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

            // Handle 401: force refresh and retry
            if (response.status === 401) {
              console.log("[dark-auth] 401 detected, forcing token refresh");
              
              invalidateCache(account.id);
              const refreshed = await refreshIfNeeded(account, true);

              if (refreshed) {
                headers.set("x-api-key", refreshed.accessToken);
                response = await fetch(input, {
                  ...init,
                  headers,
                });
              }
            }

            // Handle 429: switch to next account if available
            if (response.status === 429) {
              const retryAfter = response.headers.get("retry-after");
              const retryMs = retryAfter
                ? parseInt(retryAfter, 10) * 1000
                : 60_000;

              console.log(
                `[dark-auth] Rate limited (retry after ${Math.round(retryMs / 1000)}s)`
              );

              // If retry-after is too long, throw instead of waiting
              if (retryMs > 30_000) {
                const wait = getShortestWait();
                const waitMsg = wait
                  ? `Shortest wait: ${Math.ceil(wait / 1000)}s`
                  : "No accounts available";
                
                throw new Error(
                  `[dark-auth] Rate limit exceeded. ${waitMsg}. Add more accounts or wait.`
                );
              }

              // Try to switch to next account
              const nextAccount = handleRateLimit(account.id, retryMs);

              if (nextAccount) {
                const nextCreds = await getCachedCredentials(nextAccount.id);
                if (nextCreds) {
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
            const storage = loadAccounts();
            
            return {
              url: "",
              instructions: `Accounts stored in: ${getStoragePath()}\nActive: ${storage.activeAccountId || "none"}\nTotal: ${storage.accounts.length}`,
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
