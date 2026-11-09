import { TokenUsageSchema } from "@nap/shared/usage";
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
  let notify: (message: unknown) => void = () => {};
  const compact = claudeCompaction({
    sessionId: "claude-session",
    subscribe(listener) {
      notify = listener;
      return () => {};
    },
    async send(prompt) {
      sent.push(prompt);
      notify({
        type: "system",
        subtype: "compact_boundary",
        session_id: "claude-session",
        compact_metadata: { pre_tokens: 42_000, post_tokens: 8_000 },
      });
      notify({ type: "result", subtype: "success", session_id: "claude-session" });
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
  let notify: (message: unknown) => void = () => {};
  const compact = claudeCompaction({
    sessionId: "s",
    subscribe(listener) {
      notify = listener;
      return () => {};
    },
    async send() {
      notify({ type: "result", subtype: "success", session_id: "s" });
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

function claudeReporting(usage: Record<string, unknown>) {
  let notify: (message: unknown) => void = () => {};
  return claudeCompaction({
    sessionId: "s",
    subscribe(listener) {
      notify = listener;
      return () => {};
    },
    async send() {
      notify({
        type: "system",
        subtype: "compact_boundary",
        session_id: "s",
        compact_metadata: { pre_tokens: 4000 },
      });
      notify({ type: "result", subtype: "success", session_id: "s", usage });
    },
    async interrupt() {},
  });
}

it("includes Claude cached input in reported compaction spend, and keeps it apart", async () => {
  const compact = claudeReporting({
    input_tokens: 2,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 1000,
    output_tokens: 40,
  });
  const result = await compact({ trustedInstructions: "", untrustedContext: "" });
  expect(result.usage).toStrictEqual({
    inputTokens: 1102,
    outputTokens: 40,
    cacheWriteTokens: 100,
    cacheReadTokens: 1000,
  });
  expect(result.afterTokens).toBeNull();
});

it("reads null Claude cache counts as none rather than discarding the whole result", async () => {
  // The same wire shape the API route sends for a model that caches nothing. A schema that
  // only tolerated an absent field would refuse the result message and leave the compaction
  // waiting for a completion it had already been sent.
  const compact = claudeReporting({
    input_tokens: 7,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    output_tokens: 3,
  });
  const result = await compact({ trustedInstructions: "", untrustedContext: "" });
  expect(result.usage).toStrictEqual({ inputTokens: 7, outputTokens: 3 });
});

/** A Codex native compaction that hears `updates`, in order, between starting and finishing. */
function codexReporting(updates: readonly unknown[]) {
  let notify: (message: unknown) => void = () => {};
  return codexCompaction({
    sessionId: "s",
    subscribe(listener) {
      notify = listener;
      return () => {};
    },
    async interrupt() {},
    async request(method) {
      if (method !== "thread/compact/start") return;
      notify({ method: "turn/started", params: { threadId: "s", turn: { id: "t" } } });
      for (const update of updates) notify(update);
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
}

type Breakdown = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
};

function tokenUpdate(total: Breakdown, last: Breakdown, threadId = "s") {
  return {
    method: "thread/tokenUsage/updated",
    params: { threadId, turnId: "t", tokenUsage: { total, last } },
  };
}

it("accounts Codex token updates once, keeping the cached input it reports apart", async () => {
  // Codex's input totals include its cached input, as the Messages API's do not: the cached part
  // is a part of `inputTokens`, so it is carried as one and the input total is left alone.
  const update = tokenUpdate(
    { inputTokens: 12000, cachedInputTokens: 9000, outputTokens: 500 },
    { inputTokens: 2000, cachedInputTokens: 1500, outputTokens: 100 },
  );
  const compact = codexReporting([
    update,
    update,
    tokenUpdate(update.params.tokenUsage.total, update.params.tokenUsage.last, "other"),
    tokenUpdate(
      { inputTokens: 12300, cachedInputTokens: 9200, outputTokens: 520 },
      { inputTokens: 300, cachedInputTokens: 200, outputTokens: 20 },
    ),
  ]);
  expect(await compact({ trustedInstructions: "", untrustedContext: "" })).toMatchObject({
    usage: { inputTokens: 2300, outputTokens: 120, cacheReadTokens: 1700 },
    afterTokens: null,
  });
});

it("carries Codex cache writes as their own part of the input", async () => {
  const compact = codexReporting([
    tokenUpdate(
      { inputTokens: 5000, cachedInputTokens: 3000, cacheWriteInputTokens: 1000, outputTokens: 40 },
      { inputTokens: 5000, cachedInputTokens: 3000, cacheWriteInputTokens: 1000, outputTokens: 40 },
    ),
    tokenUpdate(
      { inputTokens: 6000, cachedInputTokens: 3800, cacheWriteInputTokens: 1100, outputTokens: 50 },
      { inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: 100, outputTokens: 10 },
    ),
  ]);
  const { usage } = await compact({ trustedInstructions: "", untrustedContext: "" });
  expect(usage).toStrictEqual({
    inputTokens: 6000,
    outputTokens: 50,
    cacheReadTokens: 3800,
    cacheWriteTokens: 1100,
  });
});

it("starts again from the last response when any Codex total goes backwards", async () => {
  // A total that shrank is a new baseline — a reconnected session, say — and differencing against
  // the old one would produce negative usage. The reported last response is what this one cost.
  const compact = codexReporting([
    tokenUpdate(
      { inputTokens: 9000, cachedInputTokens: 8000, outputTokens: 300 },
      { inputTokens: 1000, cachedInputTokens: 500, outputTokens: 30 },
    ),
    // Only the cached part went backwards.
    tokenUpdate(
      { inputTokens: 9500, cachedInputTokens: 100, outputTokens: 310 },
      { inputTokens: 400, cachedInputTokens: 100, outputTokens: 10 },
    ),
  ]);
  const { usage } = await compact({ trustedInstructions: "", untrustedContext: "" });
  expect(usage).toStrictEqual({ inputTokens: 1400, outputTokens: 40, cacheReadTokens: 600 });
});

it("charges a Codex that reports no cache fields as uncached, and never splits more than the input", async () => {
  const compact = codexReporting([
    tokenUpdate({ inputTokens: 700, outputTokens: 7 }, { inputTokens: 700, outputTokens: 7 }),
    // Cached parts larger than the input they belong to are clamped to it.
    tokenUpdate(
      { inputTokens: 800, cachedInputTokens: 900, cacheWriteInputTokens: 50, outputTokens: 8 },
      { inputTokens: 100, cachedInputTokens: 900, cacheWriteInputTokens: 50, outputTokens: 1 },
    ),
  ]);
  const { usage } = await compact({ trustedInstructions: "", untrustedContext: "" });
  // The second total's cached part (clamped to its 800 input) grew by 800 against an input that
  // grew by 100, so the delta's cached part is clamped to that 100.
  expect(usage).toStrictEqual({ inputTokens: 800, outputTokens: 8, cacheReadTokens: 100 });
  expect(TokenUsageSchema.safeParse(usage).success).toBe(true);
});
