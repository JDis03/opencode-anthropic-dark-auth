import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Account } from "./types.js";

// Shared mutable state hoisted above vi.mock() so each test can change what
// the mocks return without depending on test ordering or vi.resetAllMocks
// wiping the implementation between tests. This was failing intermittently
// on CI: a prior test's mockReturnValue assignment leaked and overshadowed
// the next test's assignment.
const mocks = vi.hoisted(() => ({
  loadAccountsReturn: null as any,
  refreshTokenReturn: null as any,
  importFromClaudeCodeReturn: null as any,
}));

// Mock the disk-backed storage module and the network-backed oauth module
// so accounts.ts logic (refresh decisions, cache, rotation) is tested in
// isolation, without touching the filesystem or making real HTTP calls.
vi.mock("./storage.js", () => ({
  loadAccounts: vi.fn(() => mocks.loadAccountsReturn),
  saveAccounts: vi.fn(),
  getActiveAccount: vi.fn(),
  importFromClaudeCode: vi.fn(() => mocks.importFromClaudeCodeReturn),
  logToFile: vi.fn(),
}));

vi.mock("./oauth.js", () => ({
  refreshToken: vi.fn(() => Promise.resolve(mocks.refreshTokenReturn)),
}));

import { loadAccounts, saveAccounts, importFromClaudeCode } from "./storage.js";
import { refreshToken } from "./oauth.js";
import {
  refreshIfNeeded,
  invalidateCache,
  handleRateLimit,
  getCachedCredentials,
} from "./accounts.js";

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    label: "Test Account",
    credentials: {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000, // 1h from now
    },
    enabled: true,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  // Reset call history but NOT implementations — the mock implementations
  // read from the hoisted `mocks` object on every call, so each test just
  // mutates `mocks.loadAccountsReturn` / `mocks.refreshTokenReturn`.
  vi.clearAllMocks();
  mocks.loadAccountsReturn = null;
  mocks.refreshTokenReturn = null;
  mocks.importFromClaudeCodeReturn = null;
  invalidateCache();
});

describe("refreshIfNeeded", () => {
  it("does not refresh when token is valid and not forced", async () => {
    const account = makeAccount();
    const result = await refreshIfNeeded(account, false);

    expect(result).toEqual(account.credentials);
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("refreshes when forced (e.g. after a 401), even if not near expiry", async () => {
    const account = makeAccount();
    const refreshed = {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    mocks.refreshTokenReturn = refreshed;
    mocks.loadAccountsReturn = {
      version: 1,
      accounts: [account],
      activeAccountId: account.id,
    };

    const result = await refreshIfNeeded(account, true);

    expect(refreshToken).toHaveBeenCalledWith("old-refresh");
    expect(result).toEqual(refreshed);
    expect(account.credentials).toEqual(refreshed); // mutated in place
    expect(saveAccounts).toHaveBeenCalled();
  });

  it("refreshes proactively when token is close to expiry, without force", async () => {
    const account = makeAccount({
      credentials: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() + 5 * 60 * 1000, // 5min — inside the 1h threshold
      },
    });
    const refreshed = {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    mocks.refreshTokenReturn = refreshed;
    mocks.loadAccountsReturn = {
      version: 1,
      accounts: [account],
      activeAccountId: account.id,
    };

    const result = await refreshIfNeeded(account, false);

    expect(refreshToken).toHaveBeenCalled();
    expect(result).toEqual(refreshed);
  });

  it("returns null when the underlying OAuth refresh call fails", async () => {
    const account = makeAccount();
    mocks.refreshTokenReturn = null;

    const result = await refreshIfNeeded(account, true);

    expect(result).toBeNull();
    expect(saveAccounts).not.toHaveBeenCalled();
  });

  it("resyncs from Claude Code's credentials file when OAuth refresh fails but a fresh import is available", async () => {
    const account = makeAccount();
    mocks.refreshTokenReturn = null;
    mocks.loadAccountsReturn = {
      version: 1,
      accounts: [account],
      activeAccountId: account.id,
    };
    const freshCredentials = {
      accessToken: "resynced-access",
      refreshToken: "resynced-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    mocks.importFromClaudeCodeReturn = {
      id: "some-other-id",
      label: "Claude Code",
      credentials: freshCredentials,
      enabled: true,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };

    const result = await refreshIfNeeded(account, true);

    expect(importFromClaudeCode).toHaveBeenCalled();
    expect(result).toEqual(freshCredentials);
    expect(saveAccounts).toHaveBeenCalled();
  });

  it("returns null when the Claude Code fallback import is also expired", async () => {
    const account = makeAccount();
    mocks.refreshTokenReturn = null;
    mocks.importFromClaudeCodeReturn = {
      id: "some-other-id",
      label: "Claude Code",
      credentials: {
        accessToken: "stale-access",
        refreshToken: "stale-refresh",
        expiresAt: Date.now() - 1000,
      },
      enabled: true,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };

    const result = await refreshIfNeeded(account, true);

    expect(result).toBeNull();
    expect(saveAccounts).not.toHaveBeenCalled();
  });
});

describe("getCachedCredentials", () => {
  it("returns null when the account cannot be found", async () => {
    mocks.loadAccountsReturn = { version: 1, accounts: [], activeAccountId: null };

    const result = await getCachedCredentials("missing-id");

    expect(result).toBeNull();
  });

  it("serves cached credentials within TTL without calling refreshToken again", async () => {
    const account = makeAccount();
    mocks.loadAccountsReturn = {
      version: 1,
      accounts: [account],
      activeAccountId: account.id,
    };
    // refreshTokenReturn stays null — token is valid for 1h, no refresh needed.

    const first = await getCachedCredentials(account.id);
    const second = await getCachedCredentials(account.id);

    expect(first).toEqual(account.credentials);
    expect(second).toEqual(account.credentials);
    // Token was valid, so refreshIfNeeded took the fast path both times —
    // no network call should have happened.
    expect(refreshToken).not.toHaveBeenCalled();
  });
});

describe("handleRateLimit — 429 rotation (regression: was dead-imported and unused)", () => {
  it("marks the current account rate-limited and rotates to the next available one", () => {
    const rateLimited = makeAccount({ id: "acc-1" });
    const other = makeAccount({ id: "acc-2" });
    mocks.loadAccountsReturn = {
      version: 1,
      accounts: [rateLimited, other],
      activeAccountId: "acc-1",
    };

    const next = handleRateLimit("acc-1", 60_000);

    expect(next?.id).toBe("acc-2");
    expect(saveAccounts).toHaveBeenCalled();
    const savedStorage = (saveAccounts as any).mock.calls[0][0];
    expect(savedStorage.activeAccountId).toBe("acc-2");
    expect(savedStorage.accounts[0].rateLimitedUntil).toBeGreaterThan(Date.now());
  });

  it("returns null when no other account is available to rotate to", () => {
    const onlyAccount = makeAccount({ id: "acc-1" });
    mocks.loadAccountsReturn = {
      version: 1,
      accounts: [onlyAccount],
      activeAccountId: "acc-1",
    };

    const next = handleRateLimit("acc-1", 60_000);

    expect(next).toBeNull();
  });

  it("skips accounts that are disabled or still rate-limited", () => {
    const rateLimited = makeAccount({ id: "acc-1" });
    const disabled = makeAccount({ id: "acc-2", enabled: false });
    const alsoLimited = makeAccount({
      id: "acc-3",
      rateLimitedUntil: Date.now() + 30_000,
    });
    mocks.loadAccountsReturn = {
      version: 1,
      accounts: [rateLimited, disabled, alsoLimited],
      activeAccountId: "acc-1",
    };

    const next = handleRateLimit("acc-1", 60_000);

    expect(next).toBeNull();
  });
});