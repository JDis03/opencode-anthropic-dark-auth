import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHttpRequest, SessionHttpResponse, SessionRetry } from "@opencode/plugin/promise/session";

const mocks = vi.hoisted(() => ({
  account: {
    id: "one", label: "Test", enabled: true,
    credentials: { accessToken: "token-one", refreshToken: "refresh-one", expiresAt: 9999999999999 },
    createdAt: 1, lastUsedAt: 1,
  },
  second: {
    id: "two", label: "Second", enabled: true,
    credentials: { accessToken: "token-two", refreshToken: "refresh-two", expiresAt: 9999999999999 },
    createdAt: 1, lastUsedAt: 1,
  },
  active: "one",
  imported: null as unknown,
}));

vi.mock("./storage.js", () => ({
  loadAccounts: vi.fn(() => ({ version: 1, accounts: [mocks.account, mocks.second], activeAccountId: mocks.active })),
  getActiveAccount: vi.fn(() => mocks.active === "two" ? mocks.second : mocks.account),
  importFromClaudeCode: vi.fn(() => mocks.imported),
  importFromAuthJson: vi.fn(() => null),
  upsertAccount: vi.fn(),
  setActiveAccount: vi.fn(),
  logToFile: vi.fn(),
}));
vi.mock("./accounts.js", () => ({
  getCachedCredentials: vi.fn(async (id: string) => id === "two" ? mocks.second.credentials : mocks.account.credentials),
  invalidateCache: vi.fn(),
  refreshIfNeeded: vi.fn(async () => ({ accessToken: "new-token", refreshToken: "new-refresh", expiresAt: 9999999999999 })),
  handleRateLimit: vi.fn(() => mocks.second),
}));
vi.mock("./oauth.js", () => ({
  generatePKCE: vi.fn(() => ({ verifier: "verifier", challenge: "challenge", createdAt: 1 })),
  buildAuthorizeURL: vi.fn(() => "https://claude.ai/authorize"),
  exchangeCode: vi.fn(),
  refreshToken: vi.fn(),
}));

import plugin, { createV2Hooks, refreshSecondaryAccounts } from "./v2.js";
import { getCachedCredentials, handleRateLimit, invalidateCache, refreshIfNeeded } from "./accounts.js";
import { importFromAuthJson, importFromClaudeCode, loadAccounts, logToFile, setActiveAccount, upsertAccount } from "./storage.js";
import { exchangeCode, refreshToken } from "./oauth.js";

const model = { providerID: "anthropic", id: "claude-sonnet" } as SessionHttpRequest["model"];
function makeEvent(body: object, url = "https://api.anthropic.com/v1/messages") {
  return {
    sessionID: "session-one", agent: "build", kind: "primary", model,
    request: new Request(url, {
      method: "POST", headers: { "x-api-key": "should-disappear", "anthropic-beta": "custom-beta" },
      body: JSON.stringify(body),
    }),
  } as SessionHttpRequest;
}
function makeRetry(status: number, attempt = 1) {
  return {
    sessionID: "session-one", agent: "build", model,
    error: { type: "provider.error", status, message: "error" },
    attempt, decision: { retry: false },
  } as SessionRetry;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.active = "one";
  mocks.imported = null;
  mocks.account.credentials = { accessToken: "token-one", refreshToken: "refresh-one", expiresAt: 9999999999999 };
  mocks.second.credentials = { accessToken: "token-two", refreshToken: "refresh-two", expiresAt: 9999999999999 };
  delete (mocks.account as typeof mocks.account & { source?: string }).source;
  vi.mocked(loadAccounts).mockImplementation(() => ({ version: 1, accounts: [mocks.account, mocks.second], activeAccountId: mocks.active }));
  vi.mocked(importFromClaudeCode).mockImplementation(() => mocks.imported as ReturnType<typeof importFromClaudeCode>);
  vi.mocked(upsertAccount).mockImplementation((account) => {
    if (account.id === mocks.account.id) Object.assign(mocks.account, account);
  });
  vi.mocked(setActiveAccount).mockImplementation((id) => { mocks.active = id; });
  vi.mocked(getCachedCredentials).mockImplementation(async (id) => id === "two" ? mocks.second.credentials : mocks.account.credentials);
  vi.mocked(handleRateLimit).mockReturnValue(mocks.second);
  vi.mocked(refreshIfNeeded).mockResolvedValue({ accessToken: "new-token", refreshToken: "new-refresh", expiresAt: 9999999999999 });
});

describe("OpenCode v2 native HTTP hooks", () => {
  it("only rewrites Anthropic Messages requests; preserves other endpoints untouched", async () => {
    const hooks = createV2Hooks();
    const event = makeEvent({ messages: [] }, "https://example.com/v1/messages");
    const original = event.request;
    await hooks.request(event);
    expect(event.request).toBe(original);
    expect(getCachedCredentials).not.toHaveBeenCalled();
  });

  it("adds OAuth headers, beta URL, billing identity and sanitized tool schemas", async () => {
    const hooks = createV2Hooks();
    const event = makeEvent({
      model: "claude-sonnet", system: [{ type: "text", text: "Custom instructions" }],
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "bash", input_schema: { oneOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { b: { type: "number" } } },
      ] } }],
    });
    await hooks.request(event);
    const headers = event.request.headers;
    expect(event.request.url).toContain("beta=true");
    expect(headers.get("authorization")).toBe("Bearer token-one");
    expect(getCachedCredentials).not.toHaveBeenCalled();
    expect(refreshIfNeeded).not.toHaveBeenCalled();
    expect(headers.has("x-api-key")).toBe(false);
    expect(headers.get("anthropic-beta")).toContain("claude-code-20250219");
    expect(headers.get("anthropic-beta")).toContain("custom-beta");
    expect(headers.get("x-app")).toBe("cli");
    expect(headers.get("x-client-request-id")).toBeTruthy();
    const body = JSON.parse(await event.request.text());
    expect(body.system[0].text).toContain("x-anthropic-billing-header");
    expect(body.system[1].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(body.messages[0].content).toContain("Custom instructions");
    expect(body.tools[0].name).toBe("mcp_Bash");
    expect(body.tools[0].input_schema.oneOf).toBeUndefined();
    expect(body.tools[0].input_schema.properties.a).toBeDefined();
  });

  it("does not preempt V2's stored OAuth refresh with 30 minutes still remaining", async () => {
    mocks.account.credentials.expiresAt = Date.now() + 30 * 60_000;
    const hooks = createV2Hooks();
    const event = makeEvent({ messages: [] });
    await hooks.request(event);
    expect(event.request.headers.get("authorization")).toBe("Bearer token-one");
    expect(getCachedCredentials).not.toHaveBeenCalled();
    expect(refreshIfNeeded).not.toHaveBeenCalled();
  });

  it("activates beta de contexto largo sin repetir prefijos si se transforma otra vez", async () => {
    const hooks = createV2Hooks();
    const event = makeEvent({ messages: [{ role: "user", content: "x".repeat(530_000) }],
      tools: [{ name: "read", input_schema: { type: "object" } }] });
    await hooks.request(event);
    expect(event.request.headers.get("anthropic-beta")).toContain("context-1m-2025-08-07");
    await hooks.request(event);
    expect(JSON.parse(await event.request.text()).tools[0].name).toBe("mcp_Read");
  });

  it("transforms streamed SSE, including tool name split across chunks", async () => {
    const hooks = createV2Hooks();
    const event = makeEvent({ messages: [{ role: "user", content: "hi" }] });
    await hooks.request(event);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: content_block_start\ndata: {"name":"mcp_'));
        controller.enqueue(encoder.encode('Bash"}\n\n'));
        controller.close();
      },
    });
    const response = { ...event, response: new Response(stream, { headers: { "content-type": "text/event-stream" } }) } as SessionHttpResponse;
    await event.request.text(); // the driver already sent/consumed the request
    await hooks.response(response);
    expect(await response.response.text()).toContain('"name": "bash"');
    expect(logToFile).toHaveBeenCalledWith(expect.stringContaining("COMPACTION DEBUG"));
  });

  it("does not rotate only the local account on 401 while V2 still stores the old token", async () => {
    const hooks = createV2Hooks();
    const event = makeEvent({ messages: [] });
    await hooks.request(event);
    const response = { ...event, response: new Response("unauthorized", { status: 401 }) } as SessionHttpResponse;
    await hooks.response(response);
    const retry = makeRetry(401);
    await hooks.retry(retry);
    expect(invalidateCache).not.toHaveBeenCalled();
    expect(refreshIfNeeded).not.toHaveBeenCalled();
    expect(retry.decision).toEqual({ retry: false });
  });

  it("bounds retries starting at attempt 1", async () => {
    const hooks = createV2Hooks();
    await hooks.request(makeEvent({ messages: [] }));
    const first = makeRetry(401);
    await hooks.retry(first);
    expect(first.decision).toEqual({ retry: false });
    const last = makeRetry(429, 3);
    await hooks.retry(last);
    expect(last.decision).toEqual({ retry: false });
    expect(handleRateLimit).not.toHaveBeenCalled();
  });

  it("rotates on 429 and re-authenticates the following request without waiting", async () => {
    const hooks = createV2Hooks();
    const event = makeEvent({ messages: [] });
    await hooks.request(event);
    await hooks.response({ ...event, response: new Response("limited", { status: 429, headers: { "retry-after": "12" } }) } as SessionHttpResponse);
    const retry = makeRetry(429);
    await hooks.retry(retry);
    expect(handleRateLimit).toHaveBeenCalledWith("one", 12_000);
    expect(retry.decision).toEqual({ retry: true, delay: 0 });
    const next = makeEvent({ messages: [] });
    await hooks.request(next);
    expect(next.request.headers.get("authorization")).toBe("Bearer token-two");
  });

  it("restores the globally active account when the rotated account has no credentials", async () => {
    const hooks = createV2Hooks();
    const event = makeEvent({ messages: [] });
    await hooks.request(event);
    vi.mocked(handleRateLimit).mockImplementationOnce(() => {
      mocks.active = "two"; // handleRateLimit persists the global rotation
      return mocks.second;
    });
    mocks.second.credentials.expiresAt = 1;
    await hooks.response({ ...event, response: new Response("limited", { status: 429, headers: { "retry-after": "1" } }) } as SessionHttpResponse);
    const retry = makeRetry(429);
    await hooks.retry(retry);
    expect(setActiveAccount).toHaveBeenCalledWith("one");
    expect(mocks.active).toBe("one");
    expect(retry.decision).toEqual({ retry: true, delay: 1000 });
    const next = makeEvent({ messages: [] });
    await hooks.request(next);
    expect(next.request.headers.get("authorization")).toBe("Bearer token-one");
  });

  it("caps 529 retry delays without an available replacement account", async () => {
    const hooks = createV2Hooks();
    const event = makeEvent({ messages: [] });
    await hooks.request(event);
    vi.mocked(handleRateLimit).mockReturnValue(null);
    await hooks.response({ ...event, response: new Response("busy", { status: 529, headers: { "retry-after": "45" } }) } as SessionHttpResponse);
    const retry = makeRetry(529);
    await hooks.retry(retry);
    expect(retry.decision).toEqual({ retry: false });
  });
});

it("registers native hooks and an OAuth integration method without making network requests", async () => {
  const hooks: Record<string, Function> = {};
  let method: { method: { id: string }; refresh: (credential: { refresh: string }) => Promise<{ access: string }>;
    authorize: () => Promise<{
    mode: string; callback: (code: string) => Promise<{ type: string; access: string }>;
  }> } | undefined;
  const ctx = {
    session: { hook: vi.fn(async (name: string, callback: Function) => { hooks[name] = callback; }) },
    integration: { transform: vi.fn(async (callback: Function) => callback({
      get: () => ({ id: "anthropic" }), method: { update: (value: typeof method) => { method = value; } },
    })) },
  };
  await plugin.setup(ctx as never);
  expect(Object.keys(hooks).sort()).toEqual(["http.request", "http.response", "retry"]);
  expect(method?.method.id).toBe("dark-auth");
  expect((await method?.authorize())?.mode).toBe("code");
  expect(upsertAccount).not.toHaveBeenCalled();
  vi.mocked(exchangeCode).mockResolvedValueOnce({ accessToken: "oauth-new", refreshToken: "oauth-refresh", expiresAt: 9999999999999 });
  const authorization = await method!.authorize();
  expect(await authorization.callback("test-code")).toMatchObject({ type: "oauth", access: "oauth-new" });
  expect(upsertAccount).toHaveBeenCalledOnce();
  expect(setActiveAccount).toHaveBeenCalledWith(expect.any(String));
  expect(await method!.refresh({ refresh: "refresh-one" })).toMatchObject({ access: "new-token" });
  expect(refreshIfNeeded).toHaveBeenCalledWith(mocks.account, true);
  vi.mocked(refreshToken).mockResolvedValueOnce({ accessToken: "external", refreshToken: "external-refresh", expiresAt: 9999999999999 });
  expect(await method!.refresh({ refresh: "untracked" })).toMatchObject({ access: "external" });
  expect(upsertAccount).toHaveBeenCalledTimes(2);
});

it("deduplicates concurrent V2 refreshes of the same single-use token", async () => {
  let method: { refresh: (credential: { refresh: string }) => Promise<{ access: string }> } | undefined;
  const ctx = {
    session: { hook: vi.fn(async () => ({})) },
    integration: { transform: vi.fn(async (callback: Function) => callback({
      get: () => ({ id: "anthropic" }), method: { update: (value: typeof method) => { method = value; } },
    })) },
  };
  await plugin.setup(ctx as never);
  let finish!: (credentials: typeof mocks.account.credentials) => void;
  vi.mocked(refreshIfNeeded).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const first = method!.refresh({ refresh: "refresh-one" });
  const second = method!.refresh({ refresh: "refresh-one" });
  expect(refreshIfNeeded).toHaveBeenCalledTimes(1);
  finish({ accessToken: "new-token", refreshToken: "new-refresh", expiresAt: 9999999999999 });
  expect(await Promise.all([first, second])).toEqual([
    expect.objectContaining({ access: "new-token" }),
    expect.objectContaining({ access: "new-token" }),
  ]);
});

it("imports Claude Code first, then auth.json when the account store is empty", async () => {
  const ctx = {
    session: { hook: vi.fn(async () => ({})) },
    integration: { transform: vi.fn(async () => ({})) },
  };
  const imported = { ...mocks.account };
  vi.mocked(loadAccounts).mockReturnValueOnce({ version: 1, accounts: [], activeAccountId: null });
  vi.mocked(importFromClaudeCode).mockReturnValueOnce(imported);
  await plugin.setup(ctx as never);
  expect(upsertAccount).toHaveBeenCalledWith({ ...imported, source: "claude-code" });
  expect(importFromAuthJson).not.toHaveBeenCalled();

  vi.clearAllMocks();
  vi.mocked(loadAccounts).mockReturnValueOnce({ version: 1, accounts: [], activeAccountId: null });
  vi.mocked(importFromClaudeCode).mockReturnValueOnce(null);
  vi.mocked(importFromAuthJson).mockReturnValueOnce(imported);
  await plugin.setup(ctx as never);
  expect(upsertAccount).toHaveBeenCalledWith(imported);
});

describe("V2 background credential sync", () => {
  const ctx = {
    session: { hook: vi.fn(async () => ({})) },
    integration: { transform: vi.fn(async () => ({})) },
  };

  it("syncs silent rotation for a matching legacy import with the same id, invalidates cache and stops on cleanup", async () => {
    vi.useFakeTimers();
    try {
      mocks.imported = { ...mocks.account, credentials: { ...mocks.account.credentials } };
      const cleanup = await plugin.setup(ctx as never);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(upsertAccount).toHaveBeenCalledWith(expect.objectContaining({ id: "one", source: "claude-code" }));

      mocks.imported = { ...mocks.account, id: "random-new-import-id", credentials: {
        accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresAt: 9999999999999,
      } };
      vi.mocked(upsertAccount).mockClear();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(upsertAccount).toHaveBeenCalledOnce();
      expect(upsertAccount).toHaveBeenCalledWith(expect.objectContaining({
        id: "one", credentials: expect.objectContaining({ accessToken: "rotated-access" }),
      }));
      expect(invalidateCache).toHaveBeenCalledWith("one");
      expect(mocks.active).toBe("one");
      expect(logToFile).not.toHaveBeenCalled();
      vi.mocked(upsertAccount).mockClear();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(upsertAccount).not.toHaveBeenCalled();
      if (cleanup) await cleanup();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not overwrite another active account or an unmarked account with different credentials", async () => {
    vi.useFakeTimers();
    try {
      mocks.imported = { ...mocks.account, id: "other-user", credentials: {
        accessToken: "other-access", refreshToken: "other-refresh", expiresAt: 9999999999999,
      } };
      const cleanup = await plugin.setup(ctx as never);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(upsertAccount).not.toHaveBeenCalled();
      mocks.active = "two";
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(upsertAccount).not.toHaveBeenCalled();
      if (cleanup) await cleanup();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("leaves an expiring V2 account to the connection's refresh callback", async () => {
    vi.useFakeTimers();
    try {
      mocks.account.credentials.expiresAt = Date.now() + 30 * 60_000;
      const cleanup = await plugin.setup(ctx as never);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(refreshIfNeeded).not.toHaveBeenCalled();
      if (cleanup) await cleanup();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("secondary account refresh (multi-account 429 rotation)", () => {
  const soon = () => Date.now() + 10 * 60_000;

  it("refreshes an expiring account that OpenCode does not own, never the owned one", async () => {
    mocks.account.credentials.expiresAt = soon();
    mocks.second.credentials.expiresAt = soon();
    const count = await refreshSecondaryAccounts({ access: "token-one", refresh: "refresh-one" });
    expect(count).toBe(1);
    expect(refreshIfNeeded).toHaveBeenCalledTimes(1);
    expect(refreshIfNeeded).toHaveBeenCalledWith(mocks.second, true);
  });

  it("skips accounts with plenty of time left, disabled ones and Claude Code imports", async () => {
    mocks.second.credentials.expiresAt = Date.now() + 3 * 60 * 60_000;
    expect(await refreshSecondaryAccounts({ refresh: "refresh-one" })).toBe(0);
    mocks.second.credentials.expiresAt = soon();
    (mocks.second as typeof mocks.second & { source?: string }).source = "claude-code";
    try {
      expect(await refreshSecondaryAccounts({ refresh: "refresh-one" })).toBe(0);
    } finally {
      delete (mocks.second as typeof mocks.second & { source?: string }).source;
    }
    mocks.second.enabled = false;
    try {
      expect(await refreshSecondaryAccounts({ refresh: "refresh-one" })).toBe(0);
    } finally {
      mocks.second.enabled = true;
    }
    expect(refreshIfNeeded).not.toHaveBeenCalled();
  });

  it("refreshes nothing when the Core credential is unknown", async () => {
    mocks.account.credentials.expiresAt = soon();
    mocks.second.credentials.expiresAt = soon();
    expect(await refreshSecondaryAccounts(undefined)).toBe(0);
    expect(refreshIfNeeded).not.toHaveBeenCalled();
  });

  it("the background timer refreshes only the secondary account", async () => {
    vi.useFakeTimers();
    try {
      mocks.account.credentials.expiresAt = soon();
      mocks.second.credentials.expiresAt = soon();
      const ctx = {
        session: { hook: vi.fn(async () => ({})) },
        integration: {
          transform: vi.fn(async () => ({})),
          connection: {
            active: vi.fn(async () => ({ type: "credential", id: "c1", label: "default" })),
            resolve: vi.fn(async () => ({ type: "oauth", access: "token-one", refresh: "refresh-one", expires: soon() })),
          },
        },
      };
      const cleanup = await plugin.setup(ctx as never);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(refreshIfNeeded).toHaveBeenCalledTimes(1);
      expect(refreshIfNeeded).toHaveBeenCalledWith(mocks.second, true);
      if (cleanup) await cleanup();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
