import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it, vi } from "vitest";
import { ClaudeNativeSession, type ClaudeQueryFactory } from "./claude-native-session.ts";

const sessionId = "00000000-0000-4000-8000-000000000001";
const config = {
  sessionId,
  model: "native-model",
  cwd: "/home/user/native-session",
  home: "/home/user",
  configDir: "/home/user/.claude",
  executablePath: "/opt/claude/claude",
  trustedInstructions: "Use the remote project tools.",
  environment: {
    PATH: "/usr/bin:/bin",
    ANTHROPIC_API_KEY: "must-not-reach-cli",
    OPENAI_API_KEY: "must-not-reach-cli",
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_SECRET_ACCESS_KEY: "must-not-reach-cli",
  },
};
const account = {
  apiProvider: "firstParty",
  apiKeySource: "none",
  tokenSource: "oauth",
  email: "ada@example.com",
  subscriptionType: "pro",
};

function fixture(
  identity: unknown = account,
  init: Record<string, unknown> = {},
  completion: Record<string, unknown> = {},
) {
  let options: Options | undefined;
  let offered = 0;
  let closed = 0;
  let interrupted = 0;
  const offeredMessages: SDKUserMessage[] = [];
  const factory: ClaudeQueryFactory = (request) => {
    options = request.options;
    return {
      initializationResult: async () => ({ account: identity }),
      interrupt: async () => {
        interrupted++;
      },
      close: () => {
        closed++;
      },
      async *[Symbol.asyncIterator]() {
        for await (const message of request.prompt) {
          offered++;
          offeredMessages.push(message);
          if (offered === 1)
            yield {
              type: "system",
              subtype: "init",
              session_id: sessionId,
              apiKeySource: "none",
              tools: [],
              mcp_servers: [{ name: "nap", status: "connected", source: "sdk" }],
              ...init,
            };
          yield {
            type: "assistant",
            session_id: sessionId,
            message: {
              role: "assistant",
              content: [{ type: "text", text: String(message.message.content) }],
            },
          };
          yield {
            type: "result",
            subtype: "success",
            session_id: sessionId,
            is_error: false,
            usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4 },
            ...completion,
          };
        }
      },
    };
  };
  return {
    factory,
    offeredMessages,
    get options() {
      return options;
    },
    get offered() {
      return offered;
    },
    get closed() {
      return closed;
    },
    get interrupted() {
      return interrupted;
    },
  };
}

it("checks native subscription authentication without offering a model prompt and strips API/cloud credentials", async () => {
  const f = fixture();
  const opened = await ClaudeNativeSession.open(config, { query: f.factory, tools: [] });
  expect(opened.ok).toBe(true);
  expect(f.offered).toBe(0);
  expect(f.options?.tools).toEqual([]);
  expect(f.options?.settingSources).toEqual([]);
  expect(f.options?.strictMcpConfig).toBe(true);
  expect(f.options?.env).toEqual({
    PATH: "/usr/bin:/bin",
    HOME: config.home,
    CLAUDE_CONFIG_DIR: config.configDir,
  });
  expect(f.options?.fallbackModel).toBeUndefined();
  if (opened.ok) opened.value.close();
});

it.each([
  { ...account, apiKeySource: "ANTHROPIC_API_KEY" },
  { ...account, apiProvider: "bedrock" },
  { ...account, tokenSource: "none" },
  {},
])("rejects API, cloud and unknown authentication before sending input: %j", async (identity) => {
  const f = fixture(identity);
  const opened = await ClaudeNativeSession.open(config, { query: f.factory, tools: [] });
  expect(opened).toMatchObject({
    ok: false,
    error: { code: "subscription_authentication_required" },
  });
  expect(f.offered).toBe(0);
  expect(f.closed).toBe(1);
});

it("allows only Nap tools registered by this SDK host and denies spoofed MCP sources and local tools", async () => {
  const f = fixture();
  const opened = await ClaudeNativeSession.open(config, { query: f.factory, tools: [] });
  expect(opened.ok).toBe(true);
  const permission = f.options?.canUseTool;
  if (!permission) throw new Error("Missing permission handler");
  const options = {
    signal: new AbortController().signal,
    toolUseID: "tool-1",
    requestId: "permission-1",
  };
  expect(
    await permission(
      "mcp__nap__run_command",
      { command: "pwd" },
      { ...options, mcpServer: { name: "nap", source: "sdk" } },
    ),
  ).toMatchObject({ behavior: "deny" });
  let release = () => {};
  let markActive = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = new Promise<void>((resolve) => {
    markActive = resolve;
  });
  if (!opened.ok) throw new Error("No fixture session");
  const running = opened.value.run({ prompt: "Edit the project" }, async () => {
    markActive();
    await gate;
  });
  await active;
  try {
    for (const [name, source] of [
      ["Bash", undefined],
      ["Read", undefined],
      ["mcp__nap__run_command", "dynamic"],
      ["mcp__nap__run_command", undefined],
      ["mcp__nap__unknown", "sdk"],
    ] as const) {
      expect(
        await permission(
          name,
          { command: "pwd" },
          { ...options, ...(source === undefined ? {} : { mcpServer: { name: "nap", source } }) },
        ),
      ).toMatchObject({ behavior: "deny" });
    }
    expect(
      await permission(
        "mcp__nap__run_command",
        { command: "pwd" },
        { ...options, mcpServer: { name: "nap", source: "sdk" } },
      ),
    ).toEqual({ behavior: "allow", updatedInput: { command: "pwd" } });
    expect(
      await permission(
        "mcp__nap__run_command",
        { command: "pwd" },
        { ...options, mcpServer: { name: "nap", source: "sdk" }, defaultToNo: true },
      ),
    ).toMatchObject({ behavior: "deny" });
    expect(
      await permission(
        "mcp__nap__run_command",
        { command: "pwd" },
        {
          ...options,
          mcpServer: { name: "nap", source: "sdk" },
          matchedAskRule: {
            source: "userSettings",
            toolName: "mcp__nap__run_command",
            ruleContent: "Ask before commands",
          },
        },
      ),
    ).toMatchObject({ behavior: "deny" });
  } finally {
    release();
    await running;
    opened.value.close();
  }
});

it("sends user text as composed input without native slash-command or local file-mention expansion", async () => {
  const f = fixture();
  const opened = await ClaudeNativeSession.open(config, { query: f.factory, tools: [] });
  if (!opened.ok) throw new Error("No fixture session");
  await opened.value.run(
    { prompt: "/login @/home/user/.claude/.credentials.json" },
    async () => {},
  );
  expect(f.offeredMessages).toMatchObject([
    { client_composed: true, message: { content: "/login @/home/user/.claude/.credentials.json" } },
  ]);
  opened.value.close();
});

it("passes image and sampled video frames as native message content with their timestamps", async () => {
  const f = fixture();
  const opened = await ClaudeNativeSession.open(config, { query: f.factory, tools: [] });
  if (!opened.ok) throw new Error("No fixture session");
  expect(
    await opened.value.run(
      {
        prompt: "Match these references",
        attachments: [
          {
            kind: "image",
            name: "layout.jpg",
            frames: [{ mediaType: "image/jpeg", data: "/9j/AAAA", timestamp: 0 }],
          },
          {
            kind: "video",
            name: "flow.webm",
            duration: 4,
            frames: [{ mediaType: "image/jpeg", data: "/9j/BBBB", timestamp: 1.5 }],
          },
        ],
      },
      async () => {},
    ),
  ).toMatchObject({ ok: true });
  expect(f.offeredMessages[0]?.message.content).toEqual([
    { type: "text", text: "Match these references" },
    { type: "text", text: "Image reference: layout.jpg" },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/AAAA" } },
    {
      type: "text",
      text: "Video reference: flow.webm, 4.0 seconds. Sampled frames follow; audio is not included.",
    },
    { type: "text", text: "Frame at 1.5s" },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/BBBB" } },
  ]);
  opened.value.close();
});

it("accepts Claude's non-executable conversation-ending control tool", async () => {
  const f = fixture(account, { tools: ["EndConversation"] });
  const opened = await ClaudeNativeSession.open(config, { query: f.factory, tools: [] });
  if (!opened.ok) throw new Error("No fixture session");
  expect(await opened.value.run({ prompt: "Edit" }, async () => {})).toMatchObject({ ok: true });
  opened.value.close();
});

it.each([
  [{ terminal_reason: "budget_exhausted" }, "limit_exceeded"],
  [{ terminal_reason: "prompt_too_long" }, "limit_exceeded"],
  [{ terminal_reason: "max_turns" }, "limit_exceeded"],
  [{ terminal_reason: "api_error" }, "unavailable"],
  [{ terminal_reason: "hook_stopped" }, "unavailable"],
  [{ terminal_reason: "aborted_tools" }, "cancelled"],
  [{ is_error: true }, "unavailable"],
  [{ api_error_status: 429 }, "limit_exceeded"],
  [{ api_error_status: 401 }, "subscription_authentication_required"],
])(
  "does not mistake a success envelope for a completed native turn: %j",
  async (completion, code) => {
    const f = fixture(account, {}, completion);
    const opened = await ClaudeNativeSession.open(config, { query: f.factory, tools: [] });
    if (!opened.ok) throw new Error("No fixture session");
    expect(await opened.value.run({ prompt: "Edit" }, async () => {})).toMatchObject({
      ok: false,
      error: { code },
    });
    expect(f.offered).toBe(1);
    opened.value.close();
  },
);

it.each([
  { tools: ["Bash"] },
  { tools: ["mcp__nap__unknown"] },
  { apiKeySource: "apiKeyHelper" },
  { mcp_servers: [{ name: "nap", status: "connected", source: "dynamic" }] },
  { mcp_servers: [{ name: "nap", status: "failed", source: "sdk" }] },
  { session_id: "a-different-session" },
])("refuses unsafe or mismatched initialization receipts: %j", async (init) => {
  const f = fixture(account, init);
  const opened = await ClaudeNativeSession.open(config, { query: f.factory, tools: [] });
  if (!opened.ok) throw new Error("No fixture session");
  const messages: unknown[] = [];
  expect(
    await opened.value.run({ prompt: "Edit" }, async (message) => {
      messages.push(message);
    }),
  ).toMatchObject({ ok: false, error: { code: "protocol_error" } });
  expect(messages).toEqual([]);
  expect(f.closed).toBe(1);
});

it("lets the native query own its conversation and reports recorded usage without another model loop", async () => {
  const f = fixture();
  const opened = await ClaudeNativeSession.open(config, { query: f.factory, tools: [] });
  if (!opened.ok) throw new Error("No fixture session");
  const messages: unknown[] = [];
  expect(
    await opened.value.run({ prompt: "First change" }, async (message) => {
      messages.push(message);
    }),
  ).toEqual({
    ok: true,
    value: { usage: { inputTokens: 16, outputTokens: 3 }, usageIncomplete: true },
  });
  expect(
    await opened.value.run({ prompt: "Second change" }, async (message) => {
      messages.push(message);
    }),
  ).toMatchObject({ ok: true });
  expect(f.offered).toBe(2);
  expect(
    messages.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "result",
    ),
  ).toHaveLength(2);
  opened.value.close();
});

it("cancels a query that ignores interruption without waiting for another provider message", async () => {
  let release = () => {};
  let markStarted = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let closed = 0;
  const factory: ClaudeQueryFactory = (request) => ({
    initializationResult: async () => ({ account }),
    interrupt: async () => {},
    close: () => {
      closed++;
    },
    async *[Symbol.asyncIterator]() {
      for await (const _message of request.prompt) {
        yield {
          type: "system",
          subtype: "init",
          session_id: sessionId,
          apiKeySource: "none",
          tools: [],
          mcp_servers: [{ name: "nap", status: "connected", source: "sdk" }],
        };
        markStarted();
        await blocked;
        yield { type: "result", subtype: "success", session_id: sessionId, is_error: false };
      }
    },
  });
  const opened = await ClaudeNativeSession.open(config, { query: factory, tools: [] });
  if (!opened.ok) throw new Error("No fixture session");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const controller = new AbortController();
  const result = opened.value.run({ prompt: "Edit", signal: controller.signal }, async () => {});
  try {
    await started;
    controller.abort();
    const response = Promise.race([
      result,
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("still running"), 25);
      }),
    ]);
    await vi.advanceTimersByTimeAsync(25);
    expect(await response).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(closed).toBe(1);
  } finally {
    release();
    await result;
    opened.value.close();
    vi.useRealTimers();
  }
});

it("bounds initialization even when the native SDK never returns its account metadata", async () => {
  let release = (_value: unknown) => {};
  let markInitialized = () => {};
  const pending = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const initialized = new Promise<void>((resolve) => {
    markInitialized = resolve;
  });
  let closed = 0;
  const factory: ClaudeQueryFactory = () => ({
    initializationResult: () => {
      markInitialized();
      return pending;
    },
    interrupt: async () => {},
    close: () => {
      closed++;
    },
    async *[Symbol.asyncIterator]() {},
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const opened = ClaudeNativeSession.open(config, {
    query: factory,
    tools: [],
    initializationTimeoutMs: 20,
  });
  try {
    await initialized;
    const response = Promise.race([
      opened,
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("still running"), 25);
      }),
    ]);
    await vi.advanceTimersByTimeAsync(25);
    expect(await response).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(closed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release({ account });
    const result = await opened;
    if (result.ok) result.value.close();
    vi.useRealTimers();
  }
});

it("bounds the whole turn even when the provider stops producing messages", async () => {
  let release = () => {};
  let markStarted = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let closed = 0;
  const query: ClaudeQueryFactory = (request) => ({
    initializationResult: async () => ({ account }),
    interrupt: async () => {},
    close: () => {
      closed++;
    },
    async *[Symbol.asyncIterator]() {
      for await (const _message of request.prompt) {
        yield {
          type: "system",
          subtype: "init",
          session_id: sessionId,
          apiKeySource: "none",
          tools: [],
          mcp_servers: [{ name: "nap", status: "connected", source: "sdk" }],
        };
        markStarted();
        await blocked;
        yield { type: "result", subtype: "success", session_id: sessionId, is_error: false };
      }
    },
  });
  const opened = await ClaudeNativeSession.open(config, { query, tools: [] });
  if (!opened.ok) throw new Error("No fixture session");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const result = opened.value.run({ prompt: "Edit", timeoutMs: 20 }, async () => {});
  try {
    await started;
    const response = Promise.race([
      result,
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("still running"), 25);
      }),
    ]);
    await vi.advanceTimersByTimeAsync(25);
    expect(await response).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect(closed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release();
    await result;
    opened.value.close();
    vi.useRealTimers();
  }
});

it("settles an active turn when its owner closes the session even if the SDK ignores close", async () => {
  let release = () => {};
  let markStarted = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const query: ClaudeQueryFactory = (request) => ({
    initializationResult: async () => ({ account }),
    interrupt: async () => {},
    close: () => {},
    async *[Symbol.asyncIterator]() {
      for await (const _message of request.prompt) {
        yield {
          type: "system",
          subtype: "init",
          session_id: sessionId,
          apiKeySource: "none",
          tools: [],
          mcp_servers: [{ name: "nap", status: "connected", source: "sdk" }],
        };
        markStarted();
        await blocked;
        yield { type: "result", subtype: "success", session_id: sessionId, is_error: false };
      }
    },
  });
  const opened = await ClaudeNativeSession.open(config, { query, tools: [] });
  if (!opened.ok) throw new Error("No fixture session");
  const result = opened.value.run({ prompt: "Edit" }, async () => {});
  try {
    await started;
    opened.value.close();
    expect(
      await Promise.race([
        result,
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("still running"), 25);
        }),
      ]),
    ).toMatchObject({ ok: false, error: { code: "cancelled" } });
  } finally {
    release();
    await result;
    opened.value.close();
  }
});
