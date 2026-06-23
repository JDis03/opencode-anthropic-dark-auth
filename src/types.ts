/**
 * Core types for opencode-anthropic-dark-auth
 */

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in milliseconds
}

export interface Account {
  id: string;
  label: string;
  credentials: OAuthCredentials;
  enabled: boolean;
  rateLimitedUntil?: number; // Unix timestamp in milliseconds
  createdAt: number;
  lastUsedAt: number;
}

export interface AccountStorage {
  version: number;
  accounts: Account[];
  activeAccountId: string | null;
}

export interface PluginConfig {
  proactiveRefreshThresholdMs: number; // Default: 60 * 60 * 1000 (1 hour)
  maxRetryDelayMs: number; // Default: 30_000 (30 seconds)
  credentialsCacheTTL: number; // Default: 30_000 (30 seconds)
  logLevel: "debug" | "info" | "warn" | "error";
}

export interface OAuthState {
  verifier: string;
  challenge: string;
  createdAt: number;
}
