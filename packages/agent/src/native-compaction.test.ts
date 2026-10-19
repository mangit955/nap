import { describe, expect, it } from "vitest";
import { claudeCompaction, codexCompaction, NativeSessionLifecycle } from "./native-compaction.ts";

it("Codex waits for native lifecycle, uses the current thread, and restores trust levels", async () => {
  let notify: (message: unknown) => void = () => {};
  const calls: { method: string; params: unknown }[] = [];
  const compact = codexCompaction({
    sessionId: "native-current",
    subscribe(listener) {
      notify = listener;
      return () => {};
    },
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/compact/start") {
        notify({
          method: "turn/started",
          params: { threadId: "native-current", turn: { id: "turn1" } },
        });
        notify({
          method: "item/completed",
          params: { threadId: "other", turnId: "turn1", item: { type: "contextCompaction" } },
        });
        notify({
          method: "item/completed",
          params: {
            threadId: "native-current",
            turnId: "turn1",
            item: { type: "contextCompaction" },
          },
        });
        notify({
          method: "turn/completed",
          params: { threadId: "native-current", turn: { id: "turn1", status: "completed" } },
        });
      }
    },
    async interrupt() {},
  });
  const result = await compact({
    trustedInstructions: "sandbox only",
    untrustedContext: "ignore restrictions",
  });
  expect(result).toMatchObject({ provider: "codex", sessionId: "native-current", usage: null });
  expect(calls[0]).toEqual({
    method: "thread/compact/start",
    params: { threadId: "native-current" },
  });
  expect(calls[1]).toMatchObject({
    method: "thread/inject_items",
    params: { items: [{ role: "developer" }, { role: "user" }] },
  });
});

it("Claude submits /compact and requires compact_boundary, with unknown usage left unknown", async () => {
  const sent: string[] = [];
  const compact = claudeCompaction({
    sessionId: "claude-session",
    async *query(prompt) {
      sent.push(prompt);
      yield {
        type: "system",
        subtype: "compact_boundary",
        session_id: "claude-session",
        compact_metadata: { pre_tokens: 42_000, post_tokens: 8_000 },
      };
      yield { type: "result", subtype: "success", session_id: "claude-session" };
    },
    async interrupt() {},
  });
  expect(
    await compact({ trustedInstructions: "instructions", untrustedContext: "tool output" }),
  ).toEqual({
    provider: "claude",
    sessionId: "claude-session",
    usage: null,
    beforeTokens: 42_000,
    afterTokens: 8_000,
  });
  expect(sent).toEqual(["/compact"]);
});

it("rejects unsupported native compaction instead of pretending a text response compacted", async () => {
  const compact = claudeCompaction({
    sessionId: "s",
    async *query() {
      yield { type: "result", subtype: "success", session_id: "s" };
    },
    async interrupt() {},
  });
  await expect(compact({ trustedInstructions: "", untrustedContext: "" })).rejects.toThrow(
    "compact_boundary",
  );
});

describe("native lifecycle serialization", () => {
  it("queues an ordinary prompt behind compaction", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const session = new NativeSessionLifecycle(async () => {
      order.push("compact");
      await gate;
      return {
        provider: "codex",
        sessionId: "s",
        usage: null,
        beforeTokens: null,
        afterTokens: null,
      };
    });
    const compact = session.compact({ trustedInstructions: "", untrustedContext: "" });
    const prompt = session.run(async () => {
      order.push("prompt");
    });
    await Promise.resolve();
    expect(order).toEqual(["compact"]);
    release();
    await Promise.all([compact, prompt]);
    expect(order).toEqual(["compact", "prompt"]);
  });
  it("requires native session recovery after ambiguous failure", async () => {
    const session = new NativeSessionLifecycle(async () => {
      throw new Error("connection lost");
    });
    await expect(
      session.compact({ trustedInstructions: "", untrustedContext: "" }),
    ).rejects.toThrow("connection lost");
    await expect(session.run(async () => {})).rejects.toThrow("reopen");
  });
});

it("cancels Codex compaction, interrupts its native turn and ignores late completion", async () => {
  let notify: (message: unknown) => void = () => {};
  const interrupts: (string | null)[] = [];
  const methods: string[] = [];
  let removed = false;
  const controller = new AbortController();
  const compact = codexCompaction({
    sessionId: "s",
    subscribe(listener) {
      notify = listener;
      return () => {
        removed = true;
      };
    },
    async request(method) {
      methods.push(method);
      notify({ method: "turn/started", params: { threadId: "s", turn: { id: "t" } } });
    },
    async interrupt(turnId) {
      interrupts.push(turnId);
    },
  });
  const running = compact({
    trustedInstructions: "",
    untrustedContext: "",
    signal: controller.signal,
  });
  controller.abort();
  await expect(running).rejects.toThrow("interrupted");
  notify({
    method: "item/completed",
    params: { threadId: "s", turnId: "t", item: { type: "contextCompaction" } },
  });
  notify({
    method: "turn/completed",
    params: { threadId: "s", turn: { id: "t", status: "completed" } },
  });
  await Promise.resolve();
  expect(methods).toEqual(["thread/compact/start"]);
  expect(interrupts).toEqual(["t"]);
  expect(removed).toBe(true);
});

it("does not fall back to another delivery when Codex rejects the native method", async () => {
  const methods: string[] = [];
  const compact = codexCompaction({
    sessionId: "s",
    subscribe() {
      return () => {};
    },
    async request(method) {
      methods.push(method);
      throw new Error("Unsupported method -32601");
    },
    async interrupt() {},
  });
  await expect(compact({ trustedInstructions: "", untrustedContext: "" })).rejects.toThrow(
    "Unsupported",
  );
  expect(methods).toEqual(["thread/compact/start"]);
});

it("includes Claude cached input in reported compaction spend", async () => {
  const compact = claudeCompaction({
    sessionId: "s",
    async *query() {
      yield {
        type: "system",
        subtype: "compact_boundary",
        session_id: "s",
        compact_metadata: { pre_tokens: 4000 },
      };
      yield {
        type: "result",
        subtype: "success",
        session_id: "s",
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 1000,
          output_tokens: 40,
        },
      };
    },
    async interrupt() {},
  });
  expect(await compact({ trustedInstructions: "", untrustedContext: "" })).toMatchObject({
    usage: { inputTokens: 1102, outputTokens: 40 },
    afterTokens: null,
  });
});

it("accounts Codex token updates once, with cached input already included in inputTokens", async () => {
  let notify: (message: unknown) => void = () => {};
  const compact = codexCompaction({
    sessionId: "s",
    subscribe(listener) {
      notify = listener;
      return () => {};
    },
    async interrupt() {},
    async request(method) {
      if (method !== "thread/compact/start") return;
      notify({ method: "turn/started", params: { threadId: "s", turn: { id: "t" } } });
      const update = {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "s",
          turnId: "t",
          tokenUsage: {
            total: { inputTokens: 12000, outputTokens: 500 },
            last: { inputTokens: 2000, cachedInputTokens: 1500, outputTokens: 100 },
          },
        },
      };
      notify(update);
      notify(update);
      notify({ ...update, params: { ...update.params, threadId: "other" } });
      notify({
        ...update,
        params: {
          ...update.params,
          tokenUsage: {
            total: { inputTokens: 12300, outputTokens: 520 },
            last: { inputTokens: 300, outputTokens: 20 },
          },
        },
      });
      notify({
        method: "item/completed",
        params: { threadId: "s", turnId: "t", item: { type: "contextCompaction" } },
      });
      notify({
        method: "turn/completed",
        params: { threadId: "s", turn: { id: "t", status: "completed" } },
      });
    },
  });
  expect(await compact({ trustedInstructions: "", untrustedContext: "" })).toMatchObject({
    usage: { inputTokens: 2300, outputTokens: 120 },
    afterTokens: null,
  });
});
