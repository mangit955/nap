import { afterEach, expect, it, vi } from "vitest";
import { claudeCompaction, codexCompaction, NativeSessionLifecycle } from "./native-compaction.ts";

afterEach(() => vi.useRealTimers());

it("retains the Codex startup subscription after cancellation to interrupt the late turn", async () => {
  let notify: (message: unknown) => void = () => {};
  const interrupts: (string | null)[] = [];
  const methods: string[] = [];
  let removed = false;
  const lifecycle = new NativeSessionLifecycle(
    codexCompaction({
      sessionId: "s",
      subscribe(listener) {
        notify = listener;
        return () => {
          removed = true;
        };
      },
      async request(method) {
        methods.push(method);
      },
      async interrupt(turnId) {
        interrupts.push(turnId);
      },
    }),
  );
  const controller = new AbortController();
  const running = lifecycle.compact({
    trustedInstructions: "",
    untrustedContext: "",
    signal: controller.signal,
  });
  await Promise.resolve();
  controller.abort();
  await expect(running).rejects.toThrow("interrupted");
  expect(removed).toBe(false);
  notify({ method: "turn/started", params: { threadId: "other", turn: { id: "wrong" } } });
  notify({ method: "turn/started", params: { threadId: "s", turn: { id: "late" } } });
  await Promise.resolve();
  expect(interrupts).toEqual(["late"]);
  notify({
    method: "item/completed",
    params: { threadId: "s", turnId: "late", item: { type: "contextCompaction" } },
  });
  notify({
    method: "turn/completed",
    params: { threadId: "s", turn: { id: "late", status: "completed" } },
  });
  await Promise.resolve();
  expect(removed).toBe(true);
  expect(methods).toEqual(["thread/compact/start"]);
  await expect(lifecycle.run(async () => {})).rejects.toThrow("reopen");
});

it("bounds Codex startup cleanup when cancellation is never followed by a start", async () => {
  vi.useFakeTimers();
  let removed = false;
  const interrupt = vi.fn(async (_turnId: string | null) => {});
  const controller = new AbortController();
  const compact = codexCompaction({
    sessionId: "s",
    subscribe() {
      return () => {
        removed = true;
      };
    },
    async request() {},
    interrupt,
  });
  const running = compact({
    trustedInstructions: "",
    untrustedContext: "",
    signal: controller.signal,
  });
  controller.abort();
  await expect(running).rejects.toThrow("interrupted");
  expect(removed).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(removed).toBe(true);
  expect(interrupt).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("cleans up a rejected Codex startup response even when cancellation arrived first", async () => {
  vi.useFakeTimers();
  let rejectStart: (error: Error) => void = () => {};
  const startup = new Promise<never>((_resolve, reject) => {
    rejectStart = reject;
  });
  let removed = false;
  const controller = new AbortController();
  const compact = codexCompaction({
    sessionId: "s",
    subscribe() {
      return () => {
        removed = true;
      };
    },
    request: () => startup,
    async interrupt() {},
  });
  const running = compact({
    trustedInstructions: "",
    untrustedContext: "",
    signal: controller.signal,
  });
  controller.abort();
  await expect(running).rejects.toThrow("interrupted");
  rejectStart(new Error("unsupported"));
  await vi.advanceTimersByTimeAsync(0);
  expect(removed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects cancellation during Codex reinjection and blocks reuse after a late response", async () => {
  let notify: (message: unknown) => void = () => {};
  let release = () => {};
  let entered = () => {};
  const injecting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const lifecycle = new NativeSessionLifecycle(
    codexCompaction({
      sessionId: "s",
      subscribe(listener) {
        notify = listener;
        return () => {};
      },
      async interrupt() {},
      async request(method) {
        if (method === "thread/inject_items") {
          entered();
          await blocked;
          return;
        }
        notify({ method: "turn/started", params: { threadId: "s", turn: { id: "t" } } });
        notify({
          method: "item/completed",
          params: { threadId: "s", turnId: "t", item: { type: "contextCompaction" } },
        });
        notify({
          method: "turn/completed",
          params: { threadId: "s", turn: { id: "t", status: "completed" } },
        });
      },
    }),
  );
  const running = lifecycle.compact({
    trustedInstructions: "",
    untrustedContext: "",
    signal: controller.signal,
  });
  await injecting;
  controller.abort();
  await expect(running).rejects.toThrow("interrupted");
  release();
  await expect(lifecycle.run(async () => {})).rejects.toThrow("reopen");
});

it("settles Claude compaction at its result while the raw session stream stays open for another turn", async () => {
  const listeners = new Set<(message: unknown) => void>();
  const sent: string[] = [];
  let streamClosed = false;
  let deliver: (message: unknown) => void = () => {};
  let close = () => {};
  const stream = async function* () {
    try {
      while (true) {
        const item = await new Promise<{ done: false; message: unknown } | { done: true }>(
          (resolve) => {
            deliver = (message) => resolve({ done: false, message });
            close = () => resolve({ done: true });
          },
        );
        if (item.done) return;
        yield item.message;
      }
    } finally {
      streamClosed = true;
    }
  };
  const raw = stream();
  const pump = (async () => {
    for await (const message of raw) for (const listener of listeners) listener(message);
  })();
  const transport = {
    sessionId: "s",
    subscribe(listener: (message: unknown) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async send(prompt: string) {
      sent.push(prompt);
    },
    async interrupt() {},
  };
  const controller = new AbortController();
  let settled = false;
  const running = claudeCompaction(transport)({
    trustedInstructions: "",
    untrustedContext: "",
    signal: controller.signal,
  }).then(
    () => {
      settled = true;
    },
    () => {},
  );
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  try {
    await flush();
    deliver({ type: "system", subtype: "compact_boundary", session_id: "s" });
    await flush();
    deliver({ type: "result", subtype: "success", session_id: "s" });
    await flush();
    expect(settled).toBe(true);
    expect(streamClosed).toBe(false);
    expect(listeners.size).toBe(0);
    expect(sent).toEqual(["/compact"]);
    const normal: unknown[] = [];
    const unsubscribe = transport.subscribe((message) => normal.push(message));
    await transport.send("continue");
    deliver({ type: "assistant", session_id: "s", text: "next answer" });
    await flush();
    expect(normal).toContainEqual({ type: "assistant", session_id: "s", text: "next answer" });
    expect(streamClosed).toBe(false);
    unsubscribe();
  } finally {
    controller.abort();
    await running;
    close();
    await flush();
    close();
    await pump;
  }
});
