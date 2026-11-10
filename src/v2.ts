/** OpenCode 2 native plugin. The V1 entrypoint remains available at ./legacy. */
import { randomUUID } from "node:crypto";
import { Plugin, type Credential } from "@opencode/plugin";
import type { SessionHttpRequest, SessionHttpResponse, SessionRetry } from "@opencode/plugin/promise/session";
import type { Account, OAuthCredentials } from "./types.js";
import { buildAuthorizeURL, exchangeCode, generatePKCE, refreshToken } from "./oauth.js";
import { handleRateLimit, invalidateCache, refreshIfNeeded } from "./accounts.js";
import { getActiveAccount, importFromAuthJson, importFromClaudeCode, loadAccounts, logToFile, setActiveAccount, upsertAccount } from "./storage.js";
import { config, TOKEN_THRESHOLDS } from "./model-config.js";
import { debugCompactionState, estimateBodyTokens, transformBody, transformResponseStream } from "./transforms.js";

const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 30_000;
const PROACTIVE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const SECONDARY_REFRESH_THRESHOLD_MS = 60 * 60 * 1000;
const METHOD_ID = "dark-auth";
const sessionId = randomUUID();

function anthropicMessages(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === "https:" && url.hostname === "api.anthropic.com" &&
    url.pathname === "/v1/messages" && request.method === "POST";
}

function retryDelay(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return attempt * 2000;
}

function oauthCredential(credentials: OAuthCredentials): Credential.OAuth {
  return {
    type: "oauth",
    methodID: METHOD_ID as Credential.OAuth["methodID"],
    access: credentials.accessToken,
    refresh: credentials.refreshToken,
    expires: credentials.expiresAt,
  };
}

/**
 * OpenCode v2 stores (and refreshes) only one Anthropic connection. Other
 * accounts kept by this plugin for 429 rotation would otherwise expire. Refresh
 * them here, but never the one OpenCode owns: rotating its refresh token
 * outside the Core store is what caused "OAuth refresh failed". Without a known
 * Core credential we cannot tell which account it owns, so refresh nothing.
 * Claude Code imports are skipped too: rotating them would break the CLI.
 */
export async function refreshSecondaryAccounts(
  core: { access?: string; refresh?: string } | undefined,
  now = Date.now(),
): Promise<number> {
  if (!core?.refresh && !core?.access) return 0;
  let refreshed = 0;
  for (const account of loadAccounts().accounts) {
    const owned = (!!core.refresh && account.credentials.refreshToken === core.refresh) ||
      (!!core.access && account.credentials.accessToken === core.access);
    if (owned || !account.enabled || account.source === "claude-code") continue;
    if (account.credentials.expiresAt - now >= SECONDARY_REFRESH_THRESHOLD_MS) continue;
    if (await refreshIfNeeded(account, true)) refreshed++;
  }
  return refreshed;
}

/** Exported separately for isolated, network-free hook tests. */
export function createV2Hooks() {
  // The retry hook has no Request/Response fields. Record only the last attempt
  // for each session and never retain a token or response body here.
  const attempts = new Map<string, { accountID: string; retryAfter: string | null; tokens: number; debug?: string }>();
  const rotated = new Map<string, string>();
  let requestCount = 0;
  let inputTokens = 0;

  async function request(event: SessionHttpRequest): Promise<void> {
    if (!anthropicMessages(event.request)) return;
    const account = loadAccounts().accounts.find((item) => item.id === rotated.get(event.sessionID)) ?? getActiveAccount();
    if (!account || !account.enabled) throw new Error("[dark-auth] No enabled account. Authenticate first.");
    // V2 owns the OAuth refresh lifecycle in its connection store. Refreshing
    // here (or in the timer below) rotates the token in our account file only,
    // leaving OpenCode's stored refresh token invalid at its next refresh.
    const credentials = account.credentials;
    if (credentials.expiresAt <= Date.now()) {
      throw new Error("[dark-auth] Account token expired; select its OAuth connection in OpenCode.");
    }

    const original = event.request;
    const raw = await original.clone().text();
    const tokens = estimateBodyTokens(raw);
    const url = new URL(original.url);
    url.searchParams.set("beta", "true");
    const headers = new Headers(original.headers);
    const betas = new Set([
      ...config.baseBetas,
      "files-api-2025-04-14",
      "extended-cache-ttl-2025-04-11",
      ...(headers.get("anthropic-beta") ?? "").split(",").map((beta) => beta.trim()).filter(Boolean),
    ]);
    if (tokens > TOKEN_THRESHOLDS.LONG_CONTEXT_BETA) {
      for (const beta of config.longContextBetas) betas.add(beta);
    }
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${credentials.accessToken}`);
    headers.set("anthropic-version", "2023-06-01");
    headers.set("anthropic-beta", [...betas].join(","));
    headers.set("anthropic-dangerous-direct-browser-access", "true");
    headers.set("x-app", "cli");
    headers.set("user-agent", `claude-cli/${process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion} (external, sdk-cli)`);
    headers.set("x-client-request-id", randomUUID());
    headers.set("X-Claude-Code-Session-Id", sessionId);
    const stainless = {
      "x-stainless-arch": process.arch,
      "x-stainless-lang": "js",
      "x-stainless-os": process.platform === "darwin" ? "MacOS" : process.platform,
      "x-stainless-package-version": "0.81.0",
      "x-stainless-retry-count": "0",
      "x-stainless-runtime": "node",
      "x-stainless-runtime-version": process.version,
      "x-stainless-timeout": "600",
    };
    for (const [key, value] of Object.entries(stainless)) {
      if (!headers.has(key)) headers.set(key, value);
    }
    // Request bodies are one-shot streams: read a clone and replace the
    // original, preserving cancellation and fetch options from the driver.
    event.request = new Request(url, {
      method: original.method,
      headers,
      body: transformBody(raw),
      signal: original.signal,
      redirect: original.redirect,
      credentials: original.credentials,
      mode: original.mode,
      referrer: original.referrer,
      referrerPolicy: original.referrerPolicy,
      integrity: original.integrity,
      keepalive: original.keepalive,
    });
    let debug: string | undefined;
    debugCompactionState(raw, (message: string) => { debug = message; });
    attempts.set(event.sessionID, { accountID: account.id, retryAfter: null, tokens, debug });
  }

  async function response(event: SessionHttpResponse): Promise<void> {
    if (!anthropicMessages(event.request)) return;
    const status = event.response.status;
    const current = attempts.get(event.sessionID);
    if (current) current.retryAfter = event.response.headers.get("retry-after");
    if (status !== 200) {
      // Do not log raw error bodies: providers may echo sensitive input.
      logToFile(`[dark-auth] Anthropic HTTP ${status}`);
    } else {
      // The request body can be consumed by fetch at this point. Reuse only
      // the metadata captured before dispatch, not a clone of event.request.
      const tokens = current?.tokens ?? 0;
      inputTokens += tokens;
      requestCount++;
      if (current?.debug) logToFile(current.debug);
      if (tokens > TOKEN_THRESHOLDS.WARN_INFO) {
        logToFile(`[dark-auth] Large context: ~${Math.round(tokens / 1000)}k tokens`);
      }
      if (requestCount % 5 === 0) {
        logToFile(`[dark-auth] Session snapshot: ${requestCount} successful requests, ~${Math.round(inputTokens / 1000)}k input tokens est.`);
      }
      const remaining = event.response.headers.get("anthropic-ratelimit-tokens-remaining");
      if (remaining !== null) logToFile(`[dark-auth] Rate limit tokens remaining: ${remaining}`);
      rotated.delete(event.sessionID);
      attempts.delete(event.sessionID);
    }
    event.response = transformResponseStream(event.response);
  }

  async function retry(event: SessionRetry): Promise<void> {
    if (event.model.providerID !== "anthropic") return;
    const state = attempts.get(event.sessionID);
    if (!state || event.attempt >= MAX_ATTEMPTS) {
      if (state) {
        attempts.delete(event.sessionID);
        rotated.delete(event.sessionID);
        event.decision = { retry: false };
      }
      return;
    }
    if (event.error.status === 401) {
      // A direct refresh here would rotate the account file but not the V2
      // connection. Never leave its persisted refresh token behind again.
      attempts.delete(event.sessionID);
      rotated.delete(event.sessionID);
      event.decision = { retry: false };
      return;
    }
    if (event.error.status !== 429 && event.error.status !== 529) return;
    const delay = retryDelay(state.retryAfter, event.attempt);
    const next = handleRateLimit(state.accountID, delay);
    if (next) {
      if (next.credentials.expiresAt > Date.now()) {
        rotated.set(event.sessionID, next.id);
        event.decision = { retry: true, delay: 0 };
        return;
      }
      // A failed rotation must not reuse a stale token for the new account.
      setActiveAccount(state.accountID);
      rotated.set(event.sessionID, state.accountID);
    }
    event.decision = delay <= MAX_RETRY_DELAY_MS
      ? { retry: true, delay }
      : { retry: false };
  }

  return { request, response, retry };
}

export default Plugin.define({
  id: "opencode-anthropic-dark-auth",
  async setup(ctx) {
    if (loadAccounts().accounts.length === 0) {
      const fromClaudeCode = importFromClaudeCode();
      const imported = fromClaudeCode ? { ...fromClaudeCode, source: "claude-code" as const } : importFromAuthJson();
      if (imported) upsertAccount(imported);
    }

    const hooks = createV2Hooks();
    await ctx.session.hook("http.request", hooks.request, { providerID: "anthropic" });
    await ctx.session.hook("http.response", hooks.response, { providerID: "anthropic" });
    await ctx.session.hook("retry", hooks.retry, { providerID: "anthropic" });

    // V2's integration method can own new logins; there is no public API to
    // import an existing OAuth credential into its connection store at setup.
    // Concurrent connection.resolve calls can present the same single-use
    // refresh token. Share the result so only one OAuth exchange is attempted.
    const inFlightRefreshes = new Map<string, Promise<Credential.OAuth>>();
    await ctx.integration.transform((editor) => {
      if (!editor.get("anthropic")) return;
      editor.method.update({
        integrationID: "anthropic",
        method: { id: METHOD_ID, type: "oauth", label: "Login with Claude Pro/Max (Dark Auth)" },
        authorize: async () => {
          const pkce = generatePKCE();
          return {
            url: buildAuthorizeURL(pkce),
            instructions: "Authorize in your browser and paste the code here.",
            mode: "code" as const,
            callback: async (code: string) => {
              const credentials = await exchangeCode(code, pkce.verifier);
              if (!credentials) throw new Error("[dark-auth] OAuth exchange failed");
              const account: Account = {
                id: randomUUID(), label: "Claude Pro/Max", credentials, enabled: true,
                createdAt: Date.now(), lastUsedAt: Date.now(),
              };
              upsertAccount(account);
              setActiveAccount(account.id);
              return oauthCredential(credentials);
            },
          };
        },
        refresh: async (credential) => {
          const pending = inFlightRefreshes.get(credential.refresh);
          if (pending) return pending;
          const refresh = (async () => {
            const account = loadAccounts().accounts.find((item) => item.credentials.refreshToken === credential.refresh);
            const updated = account
              ? await refreshIfNeeded(account, true)
              : await refreshToken(credential.refresh);
            if (!updated) throw new Error("[dark-auth] OAuth refresh failed");
            if (!account) {
              const imported: Account = {
                id: randomUUID(), label: "Claude Pro/Max", credentials: updated, enabled: true,
                createdAt: Date.now(), lastUsedAt: Date.now(),
              };
              upsertAccount(imported);
              setActiveAccount(imported.id);
            }
            return oauthCredential(updated);
          })();
          inFlightRefreshes.set(credential.refresh, refresh);
          try {
            return await refresh;
          } finally {
            inFlightRefreshes.delete(credential.refresh);
          }
        },
      });
    });

    // Only follow Claude Code for accounts imported from it. For pre-marker
    // accounts, an exact token match can safely establish that provenance.
    // A different account in Claude Code must never overwrite the active one.
    let running = false;
    const refreshTimer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        try {
          const connection = await ctx.integration.connection?.active("anthropic");
          const value = connection ? await ctx.integration.connection.resolve(connection) : undefined;
          await refreshSecondaryAccounts(value?.type === "oauth" ? value : undefined);
        } catch {
          // Best-effort; never log credentials.
        }
        const current = getActiveAccount();
        if (!current || !current.enabled) return;
        const imported = importFromClaudeCode();
        const matches = imported && (
          (imported.credentials.accessToken !== "" &&
            imported.credentials.accessToken === current.credentials.accessToken) ||
          (imported.credentials.refreshToken !== "" &&
            imported.credentials.refreshToken === current.credentials.refreshToken)
        );
        if (imported && (current.source === "claude-code" || matches)) {
          // Do not replace a more recent login/rotation or a changed active account.
          const latest = getActiveAccount();
          if (!latest || latest.id !== current.id ||
            latest.credentials.accessToken !== current.credentials.accessToken) return;
          if (imported.credentials.expiresAt > Date.now() &&
            (latest.credentials.accessToken !== imported.credentials.accessToken ||
              latest.credentials.refreshToken !== imported.credentials.refreshToken ||
              latest.credentials.expiresAt !== imported.credentials.expiresAt ||
              latest.source !== "claude-code")) {
            upsertAccount({ ...latest, source: "claude-code", credentials: imported.credentials });
            invalidateCache(latest.id);
            return;
          }
        }
        // Only V2's connection.resolve may refresh OAuth credentials. The
        // periodic Claude Code import above is a sync, not a token refresh.
      } catch {
        // Background refresh is best-effort; never log credentials or file errors.
      } finally {
        running = false;
      }
    }, PROACTIVE_REFRESH_INTERVAL_MS);
    refreshTimer.unref();
    return () => clearInterval(refreshTimer);
  },
});
