/**
 * OAuth PKCE flow implementation
 * Based on RFC 7636 (PKCE) and Anthropic's OAuth spec
 */

import { createHash, randomBytes } from "node:crypto";
import type { OAuthCredentials, OAuthState } from "./types.js";

// Anthropic OAuth endpoints
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPE = "org:create_api_key user:profile user:inference";

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
 */
export async function exchangeCode(
  code: string,
  verifier: string
): Promise<OAuthCredentials | null> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      }).toString(),
    });

    if (!response.ok) {
      console.error(`[dark-auth] Token exchange failed: ${response.status}`);
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
    console.error("[dark-auth] Token exchange error:", error);
    return null;
  }
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
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }).toString(),
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
