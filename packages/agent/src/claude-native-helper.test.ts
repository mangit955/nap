import { expect, it, vi } from "vitest";
import { ClaudeNativeHelper } from "./claude-native-helper.ts";
import type { ClaudeQueryFactory } from "./claude-native-session.ts";

const sessionId = "00000000-0000-4000-8000-000000000001";
const start = {
  type: "start",
  runId: "00000000-0000-4000-8000-000000000002",
  config: {
    sessionId,
    model: "native",
    cwd: "/native/session",
    home: "/native/home",
    configDir: "/native/home/.claude",
    executablePath: "/opt/claude/claude",
    trustedInstructions: "Use Nap tools",
    environment: { PATH: "/usr/bin:/bin" },
  },
  prompt: "Build the page",
};
function fixture() {
  const output: unknown[] = [];
  let prompts = 0;
  const query = vi.fn<ClaudeQueryFactory>((request) => ({
    initializationResult: async () => ({
      account: { apiProvider: "firstParty", apiKeySource: "none", tokenSource: "oauth" },
    }),
    interrupt: async () => {},
    close: () => {},
    async *[Symbol.asyncIterator]() {
      for await (const _prompt of request.prompt) {
        prompts++;
        yield {
          type: "system",
          subtype: "init",
          session_id: sessionId,
          apiKeySource: "none",
          tools: [],
          mcp_servers: [{ name: "nap", source: "sdk", status: "connected" }],
        };
        yield { type: "user", session_id: sessionId, message: { content: "private input echo" } };
        yield {
          type: "assistant",
          session_id: sessionId,
          message: { role: "assistant", content: [{ type: "text", text: "Built" }] },
        };
        yield {
          type: "result",
          session_id: sessionId,
          subtype: "success",
          is_error: false,
          usage: { input_tokens: 2, output_tokens: 3 },
        };
      }
    },
  }));
  const helper = new ClaudeNativeHelper({
    query,
    write: async (frame) => {
      output.push(frame);
    },
  });
  return {
    helper,
    query,
    output,
    get prompts() {
      return prompts;
    },
  };
}
it("does not initialize Claude until its private start command and accepts exactly one prompt", async () => {
  const f = fixture();
  expect(f.query).not.toHaveBeenCalled();
  await f.helper.accept(start);
  await f.helper.closed;
  expect(f.prompts).toBe(1);
  expect(f.output).toMatchObject([
    { type: "message", message: { subtype: "init" } },
    { type: "message", message: { type: "assistant" } },
    { type: "message", message: { type: "result" } },
    {
      type: "finished",
      result: {
        ok: true,
        value: { usage: { inputTokens: 2, outputTokens: 3 }, usageIncomplete: true },
      },
    },
  ]);
  await expect(f.helper.accept(start)).rejects.toThrow();
  expect(f.prompts).toBe(1);
});
it.each([
  {},
  { ...start, config: { ...start.config, home: "relative" } },
  { type: "cancel", extra: "untrusted" },
])("rejects malformed commands before any native query: %j", async (command) => {
  const f = fixture();
  await expect(f.helper.accept(command)).rejects.toThrow();
  await f.helper.closed;
  expect(f.query).not.toHaveBeenCalled();
});
it("closes a stalled native prompt on cancellation without invoking a second query", async () => {
  const f = fixture();
  let initialized = () => {};
  const seen = new Promise<void>((resolve) => {
    initialized = resolve;
  });
  f.query.mockImplementation(() => ({
    initializationResult: async () => {
      initialized();
      return { account: { apiProvider: "firstParty", apiKeySource: "none", tokenSource: "oauth" } };
    },
    interrupt: async () => {},
    close: () => {},
    async *[Symbol.asyncIterator]() {
      await new Promise<void>(() => {});
      yield {};
    },
  }));
  await f.helper.accept(start);
  await seen;
  await f.helper.accept({ type: "cancel" });
  await f.helper.closed;
  expect(f.query).toHaveBeenCalledTimes(1);
  expect(f.output.at(-1)).toMatchObject({ type: "finished", result: { ok: false } });
});

it("carries a real MCP tool request and its receipt across the helper's private command channel", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const calls: unknown[] = [];
  let result: unknown;
  let helper: ClaudeNativeHelper;
  const factory: ClaudeQueryFactory = (request) => ({
    initializationResult: async () => ({
      account: { apiProvider: "firstParty", apiKeySource: "none", tokenSource: "oauth" },
    }),
    interrupt: async () => {},
    close: () => {},
    async *[Symbol.asyncIterator]() {
      for await (const _prompt of request.prompt) {
        yield {
          type: "system",
          subtype: "init",
          session_id: sessionId,
          apiKeySource: "none",
          tools: [],
          mcp_servers: [{ name: "nap", source: "sdk", status: "connected" }],
        };
        const server = request.options.mcpServers?.nap;
        if (server?.type !== "sdk") throw new Error("Missing scoped MCP server");
        const client = new Client({ name: "offline-helper-proof", version: "1.0.0" });
        const [left, right] = InMemoryTransport.createLinkedPair();
        await server.instance.connect(right);
        await client.connect(left);
        try {
          result = await client.callTool({ name: "run_command", arguments: { command: "pwd" } });
        } finally {
          await client.close();
          await server.instance.close();
        }
        yield { type: "result", subtype: "success", session_id: sessionId, is_error: false };
      }
    },
  });
  helper = new ClaudeNativeHelper({
    query: factory,
    write: async (frame) => {
      if (frame.type === "tool_call") {
        calls.push(frame.call);
        await helper.accept({
          type: "tool_reply",
          id: frame.call.id,
          reply: { ok: true, value: { ok: true, output: "/home/user/app" } },
        });
      }
    },
  });
  await helper.accept(start);
  await helper.closed;
  expect(calls).toMatchObject([
    { id: expect.stringMatching(/^[a-f0-9]{64}$/), tool: "run_command", input: { command: "pwd" } },
  ]);
  expect(result).toMatchObject({
    isError: false,
    content: [{ type: "text", text: "/home/user/app" }],
  });
});

it("rejects a second start while the first query is still active", async () => {
  const f = fixture();
  await f.helper.accept(start);
  await expect(f.helper.accept(start)).rejects.toThrow("Native start cannot be replayed");
  await f.helper.closed;
  expect(f.query.mock.calls.length).toBeLessThanOrEqual(1);
});
