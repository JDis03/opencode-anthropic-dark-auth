/**
 * OAuth PKCE flow implementation
 * Based on RFC 7636 (PKCE) and Anthropic's OAuth spec
 * Endpoints match opencode-anthropic-fix (multi-auth): platform.claude.com
 */

import { createHash, randomBytes } from "node:crypto";
import type { OAuthCredentials, OAuthState } from "./types.js";

// Anthropic OAuth endpoints — platform.claude.com (not console.anthropic.com)
// matches what Claude Code's official axios client uses
const OAUTH_HOST = "platform.claude.com";
const TOKEN_URL = `https://${OAUTH_HOST}/v1/oauth/token`;
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = `https://${OAUTH_HOST}/oauth/code/callback`;

// Scopes matching Claude Code's official client
const CLAUDE_AI_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

// Match axios fingerprint to avoid rate-limit detection
const OAUTH_ACCEPT = "application/json, text/plain, */*";
const OAUTH_USER_AGENT = "axios/1.13.6";

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Generate PKCE challenge and verifier
 */
export function generatePKCE(): OAuthState {
  // Generate cryptographically secure random verifier (43-128 chars)
  const verifier = randomBytes(32).toString("base64url");
  
  // Create SHA256 challenge from verifier
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");

  return {
    verifier,
    challenge,
    createdAt: Date.now(),
  };
}

/**
 * Build OAuth authorization URL (Claude.ai "max" mode)
 */
export function buildAuthorizeURL(state: OAuthState): string {
  const url = new URL("https://claude.ai/oauth/authorize");
  
  url.searchParams.set("code", "true");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", CLAUDE_AI_SCOPES.join(" "));
  url.searchParams.set("code_challenge", state.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state.verifier); // Use verifier as state

  return url.toString();
}

/**
 * Parse OAuth callback into { code, state }.
 * Handles all formats: full URL, query string, hash fragment, bare code#state, plain code.
 */
export function parseOAuthCallback(
  input: string | null | undefined
): { code: string; state: string | null } {
  if (!input || typeof input !== "string")
    return { code: "", state: null };
  const trimmed = input.trim();
  if (!trimmed) return { code: "", state: null };

  // Attempt 1: full URL (https://...)
  if (trimmed.includes("://")) {
    try {
      const url = new URL(trimmed);
      const hashStr = url.hash.slice(1);
      if (hashStr && hashStr.includes("=")) {
        const hashParams = new URLSearchParams(hashStr);
        const hCode = hashParams.get("code");
        if (hCode)
          return { code: hCode, state: hashParams.get("state") };
      }
      const qCode = url.searchParams.get("code");
      if (qCode)
        return { code: qCode, state: url.searchParams.get("state") };
    } catch {
      // fall through
    }
  }

  // Attempt 2: query string ("?code=X&state=Y" or "code=X&state=Y")
  {
    const qs = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
    if (qs.includes("=") && (qs.startsWith("code") || qs.includes("&code"))) {
      try {
        const params = new URLSearchParams(qs);
        const qCode = params.get("code");
        if (qCode)
          return { code: qCode, state: params.get("state") };
      } catch {
        // fall through
      }
    }
  }

  // Attempt 3: bare hash "#code=X&state=Y"
  if (trimmed.startsWith("#")) {
    const hashStr = trimmed.slice(1);
    if (hashStr.includes("=")) {
      try {
        const params = new URLSearchParams(hashStr);
        const hCode = params.get("code");
        if (hCode)
          return { code: hCode, state: params.get("state") };
      } catch {
        // fall through
      }
    }
  }

  // Attempt 4: "code#state" bare format
  const hashIdx = trimmed.indexOf("#");
  if (hashIdx > 0) {
    const codePart = trimmed.slice(0, hashIdx);
    const statePart = trimmed.slice(hashIdx + 1);
    return { code: codePart, state: statePart || null };
  }

  // Attempt 5: plain code
  return { code: trimmed, state: null };
}

/**
 * Check if an HTTP status is retryable for token endpoints
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * Calculate retry delay with exponential backoff, capped
 */
function getRetryDelayMs(attempt: number): number {
  const delay = RETRY_BASE_MS * Math.pow(2, attempt);
  return Math.max(250, Math.min(delay, MAX_RETRY_DELAY_MS));
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCode(
  callbackValue: string,
  verifier: string
): Promise<OAuthCredentials | null> {
  const { code, state } = parseOAuthCallback(callbackValue);

  if (!code) {
    console.error("[dark-auth] No authorization code found in callback");
    return null;
  }

  console.log("[dark-auth] Exchanging code for tokens...");
  let lastError: string | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = getRetryDelayMs(attempt - 1);
      console.log(`[dark-auth] Retrying exchange in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const exchangeBody: Record<string, string> = {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      };
      if (state != null) {
        exchangeBody.state = state;
      }

      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: OAUTH_ACCEPT,
          "Content-Type": "application/json",
          "User-Agent": OAUTH_USER_AGENT,
        },
        body: JSON.stringify(exchangeBody),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.ok) {
        const data = (await response.json()) as {
          access_token: string;
          refresh_token: string;
          expires_in: number;
        };
        console.log("[dark-auth] Token exchange successful");
        return {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: Date.now() + data.expires_in * 1000,
        };
      }

      // Read error body
      const errorBody = await response.text().catch(() => "");
      lastError = `${response.status} — ${errorBody.slice(0, 200)}`;
      console.error(
        `[dark-auth] Token exchange attempt ${attempt + 1} failed: ${lastError}`
      );

      if (attempt < MAX_RETRIES - 1 && isRetryableStatus(response.status)) {
        continue; // Rate limit or server error — retryable
      }
      break; // Non-retryable or out of attempts
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error(
        `[dark-auth] Token exchange error (attempt ${attempt + 1}): ${lastError}`
      );
      if (attempt < MAX_RETRIES - 1) continue; // Network errors retryable
    }
  }

  console.error(`[dark-auth] Token exchange exhausted: ${lastError}`);
  return null;
}

/**
 * Refresh access token using refresh token
 * Includes retry logic for transient failures, matching multi-auth pattern
 */
export async function refreshToken(
  refreshTokenValue: string
): Promise<OAuthCredentials | null> {
  let lastError: string | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = getRetryDelayMs(attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: OAUTH_ACCEPT,
          "Content-Type": "application/json",
          "User-Agent": OAUTH_USER_AGENT,
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshTokenValue,
          client_id: CLIENT_ID,
          scope: CLAUDE_AI_SCOPES.join(" "),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        lastError = `${response.status} — ${errorBody.slice(0, 200)}`;
        console.error(`[dark-auth] Token refresh attempt ${attempt + 1} failed: ${lastError}`);

        if (attempt < MAX_RETRIES - 1 && isRetryableStatus(response.status)) {
          continue;
        }
        return null;
      }

      const data = (await response.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error(`[dark-auth] Token refresh error (attempt ${attempt + 1}): ${lastError}`);
      if (attempt < MAX_RETRIES - 1) continue;
    }
  }

  console.error(`[dark-auth] Token refresh exhausted: ${lastError}`);
  return null;
}
