/**
 * OAuth PKCE flow implementation
 * Based on RFC 7636 (PKCE) and Anthropic's OAuth spec
 */

import { createHash, randomBytes } from "node:crypto";
import type { OAuthCredentials, OAuthState } from "./types.js";

// Anthropic OAuth endpoints (matching opencode-anthropic-fix)
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPE = "org:create_api_key user:profile user:inference";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000; // 2 seconds base

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
 * Build OAuth authorization URL
 */
export function buildAuthorizeURL(state: OAuthState): string {
  const url = new URL(AUTHORIZE_URL);
  
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", state.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state.verifier); // Use verifier as state for simplicity

  return url.toString();
}

/**
 * Exchange authorization code for tokens
 * callbackValue is the full callback value from OpenCode (contains code=XX#state=YY)
 */
export async function exchangeCode(
  callbackValue: string,
  verifier: string
): Promise<OAuthCredentials | null> {
  // Parse Anthropic callback: ?code=CODE or code=CODE#state=STATE
  let code: string;
  let state: string;

  // Try parsing as URL first
  try {
    const url = new URL(callbackValue);
    code = url.searchParams.get("code") || "";
    state = url.searchParams.get("state") || "";
  } catch {
    // Try splitting by # (code#state format)
    const parts = callbackValue.split("#");
    code = parts[0] || "";
    state = parts[1] || "";
    
    // If code starts with code=, extract it
    if (code.includes("code=")) {
      const match = code.match(/code=([^&]*)/);
      code = match ? match[1] : code;
    }
  }

  if (!code) {
    console.error("[dark-auth] No authorization code found in callback");
    return null;
  }

  console.log("[dark-auth] Exchanging code for tokens...");

  // Retry with backoff for transient errors (rate limits, network)
  let lastError: string | null = null;
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`[dark-auth] Retrying exchange in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code,
          state,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        }),
      });

      if (response.ok) {
        const data = await response.json() as {
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
      console.error(`[dark-auth] Token exchange attempt ${attempt + 1} failed: ${lastError}`);

      // Don't retry on client errors (4xx except 429)
      if (response.status === 429 || response.status >= 500) {
        continue; // Rate limit or server error — retryable
      }
      break; // Other 4xx (400, 401, 403) — not retryable
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error(`[dark-auth] Token exchange error (attempt ${attempt + 1}): ${lastError}`);
      // Network errors are retryable
    }
  }

  console.error(`[dark-auth] Token exchange exhausted: ${lastError}`);
  return null;
}

/**
 * Refresh access token using refresh token
 */
export async function refreshToken(
  refreshToken: string
): Promise<OAuthCredentials | null> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      console.error(`[dark-auth] Token refresh failed: ${response.status}`);
      return null;
    }

    const data = await response.json() as {
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
    console.error("[dark-auth] Token refresh error:", error);
    return null;
  }
}
