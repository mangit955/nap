import { NapAgentService } from "@nap/agent/agent-service";
import { ScriptedLLMProvider, type ScriptedTurn } from "@nap/agent/testing/scripted-llm-provider";
import {
  COMPACTION_HISTORY_DIR,
  compactionHistoryPath,
  renderCompactionHistory,
} from "@nap/context/compaction-history";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { scriptGit } from "@nap/sandbox/testing/script-git";
import { latestCheckpoint } from "@nap/shared/compaction";
import type { LLMProvider, LLMRequest, LLMTurnResult } from "@nap/shared/ports/llm-provider";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { describe, expect, it } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";

const SESSION = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-000000000002";
const EARLY = "Keep keyboard navigation and the purple theme. Never deploy.";
function fixture(
  provider: LLMProvider,
  budgetTokens = 80_000,
  maxTokens = 400_000,
  Sandbox = InMemorySandboxManager,
) {
  const events = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const sessions = new InMemorySessionStore([{ sessionId: SESSION, projectId: PROJECT }]);
  const sandbox = scriptGit(
    new Sandbox({
      // Many lines rather than one: a read cuts a single line at a couple of thousand
      // characters, and this file exists to make each read large.
      seed: { "/home/user/app/large.txt": "tool-output\n".repeat(2200) },
    }),
    { dirty: false },
  );
  const restart = (nextProvider = provider, restorable = false) =>
    new SingleAgentRuntime({
      ...(restorable
        ? { objects: new InMemoryObjectStore(), snapshots: new InMemorySnapshotStore() }
        : {}),
      events,
      bus,
      sessions,
      sandbox,
      memory: new NoopMemoryProvider(),
      context: new NapContextEngine({ budgetTokens }),
      agent: new NapAgentService({ provider: nextProvider, budget: { maxTokens, maxSteps: 24 } }),
    });
  const runtime = restart();
  const run = (message: string, signal?: AbortSignal) =>
    runtime.runTurn({
      turnId: crypto.randomUUID(),
      sessionId: SESSION,
      message,
      ...(signal === undefined ? {} : { signal }),
    });
  return {
    events,
    bus,
    sessions,
    sandbox,
    runtime,
    restart,
    run,
    history: () => events.readFrom(SESSION, 0),
  };
}

it("manual compaction persists a boundary, retains early instructions and survives runtime restart", async () => {
  const provider = new ScriptedLLMProvider([
    [{ text: "old assistant detail ".repeat(500) }],
    [
      {
        text: "Summary deliberately omits the early constraint",
        usage: { inputTokens: 1200, outputTokens: 80 },
      },
    ],
  ]);
  const f = fixture(provider);
  expect((await f.run(EARLY)).ok).toBe(true);
  const original = await f.history();
  expect((await f.run("/compact")).ok).toBe(true);
  const compacted = await f.history();
  expect(compacted.slice(0, original.length)).toEqual(original);
  const checkpoint = latestCheckpoint(compacted);
  expect(checkpoint).toBeDefined();
  expect(compacted.filter((e) => e.type === "user.message")).toHaveLength(1);
  expect(compacted.filter((e) => e.type === "job.started")).toHaveLength(1);
  const completion = compacted.findLast((e) => e.type === "turn.completed");
  expect(completion?.payload).toMatchObject({
    usage: { inputTokens: 1200, outputTokens: 80 },
    commitSha: null,
  });

  const next = new ScriptedLLMProvider([[{ text: "new answer" }]]);
  await f
    .restart(next)
    .runTurn({ turnId: crypto.randomUUID(), sessionId: SESSION, message: "Now add a filter" });
  const request = next.requests[0]!;
  const conversation = JSON.stringify(request.messages);
  expect(conversation.split(EARLY)).toHaveLength(2);
  expect(conversation.split("Now add a filter")).toHaveLength(2);
  expect(conversation).not.toContain("old assistant detail");
  expect(conversation).toContain(checkpoint!.summary);
  expect(request.systemPrompt).not.toContain(checkpoint!.summary);
});

/** A model that keeps reading a large file, so its turn outgrows a small budget mid-loop. */
function readingModel() {
  const requests: LLMRequest[] = [];
  let normal = 0;
  const provider: LLMProvider = {
    startTurn() {
      let inputTokens = 0;
      let outputTokens = 0;
      return {
        usage: () => ({ inputTokens, outputTokens }),
        async complete(request) {
          const {
            signal: _signal,
            onThinkingDelta: _thinking,
            onTextDelta: _text,
            ...recorded
          } = request;
          requests.push(structuredClone(recorded));
          const summarizing = request.purpose === "compaction";
          inputTokens += summarizing ? 100 : 10_000;
          outputTokens += 10;
          const toolCalls =
            summarizing || normal++ >= 4
              ? []
              : [
                  {
                    id: `r${normal}`,
                    name: "read_file",
                    input: { path: "/home/user/app/large.txt" },
                  },
                ];
          return {
            type: "message",
            text: summarizing
              ? "Files inspected. Continue the request with its original constraints."
              : "",
            toolCalls,
            usage: { inputTokens: summarizing ? 100 : 10_000, outputTokens: 10 },
          };
        },
      };
    },
  };
  return { provider, requests };
}

it("compacts within a tool loop, preserves complete pairs, and charges summary calls to that turn", async () => {
  const { provider, requests } = readingModel();
  const f = fixture(provider, 24_000);
  const outcome = await f.run(EARLY);
  const history = await f.history();
  expect(outcome.ok).toBe(true);
  const compacted = history.find((e) => e.type === "compaction.completed");
  expect(compacted).toBeDefined();
  expect(history.findIndex((e) => e.type === "tool.result")).toBeLessThan(
    history.indexOf(compacted!),
  );
  expect(history.findLastIndex((e) => e.type === "tool.result")).toBeGreaterThan(
    history.indexOf(compacted!),
  );
  expect(history.filter((e) => e.type === "tool.call")).toHaveLength(4);
  const after = requests.filter((r) => r.purpose !== "compaction").at(-1)!;
  expect(JSON.stringify(after.messages)).toContain(EARLY);
  // The turn that compacted is told about the file then and there, not only from the next turn.
  expect(JSON.stringify(after.messages)).toContain(compactionHistoryPath(SESSION));
  expect(JSON.stringify(after.messages)).not.toContain("not available in this sandbox");
  for (const request of requests.filter((r) => r.purpose !== "compaction")) {
    const blocks = request.messages.flatMap((m) =>
      typeof m.content === "string" ? [] : m.content,
    );
    expect(
      blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => b.id)
        .sort(),
    ).toEqual(
      blocks
        .filter((b) => b.type === "tool_result")
        .map((b) => b.toolCallId)
        .sort(),
    );
  }
  const summaries = requests.filter((r) => r.purpose === "compaction").length;
  const terminal = history.findLast((e) => e.type === "turn.completed");
  expect(terminal?.payload).toMatchObject({
    usage: { inputTokens: 50_000 + summaries * 100, outputTokens: requests.length * 10 },
  });
  const checkpoint = latestCheckpoint(history)!;
  const retained = checkpoint.tail
    .flatMap((message) => (typeof message.content === "string" ? [] : message.content))
    .flatMap((block) => (block.type === "tool_use" ? [block.id] : []));
  const fresh = history.flatMap((event) =>
    event.seq > checkpoint.coveredThrough && event.type === "tool.call"
      ? [event.payload.toolCallId]
      : [],
  );
  const restarted = new ScriptedLLMProvider([[{ text: "done" }]]);
  await f.restart(restarted).runTurn({
    turnId: crypto.randomUUID(),
    sessionId: SESSION,
    message: "Continue after restart",
  });
  const resumed = restarted.requests[0]!.messages.flatMap((message) =>
    typeof message.content === "string" ? [] : message.content,
  );
  expect(resumed.flatMap((block) => (block.type === "tool_use" ? [block.id] : []))).toEqual([
    ...retained,
    ...fresh,
  ]);
  expect(
    resumed.flatMap((block) => (block.type === "tool_result" ? [block.toolCallId] : [])),
  ).toEqual([...retained, ...fresh]);
});

it("keeps the previous checkpoint on a failed summary and records its spent usage", async () => {
  const scripts: ScriptedTurn[] = [
    [{ text: "history" }],
    [{ text: "old summary" }],
    [{ text: "new work" }],
    [
      {
        error: { message: "unavailable", retryable: true },
        usage: { inputTokens: 123, outputTokens: 4 },
      },
    ],
  ];
  const f = fixture(new ScriptedLLMProvider(scripts));
  await f.run(EARLY);
  await f.run("/compact");
  await f.run("new request");
  const previous = latestCheckpoint(await f.history());
  expect((await f.run("/compact")).ok).toBe(false);
  expect(latestCheckpoint(await f.history())).toEqual(previous);
  expect(
    (await f.history()).findLast((e) => e.type === "compaction.failed")?.payload,
  ).toMatchObject({ cancelled: false, usage: { inputTokens: 123, outputTokens: 4 } });
});

it("cancels a pending summary, ignores late completion, and serializes the next prompt", async () => {
  let release: (result: LLMTurnResult) => void = () => {};
  let started = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<LLMTurnResult>((resolve) => {
    release = resolve;
  });
  let turns = 0;
  const provider: LLMProvider = {
    startTurn() {
      const number = ++turns;
      return {
        usage: () => ({ inputTokens: 0, outputTokens: 0 }),
        async complete(request) {
          if (request.purpose === "compaction") {
            started();
            return blocked;
          }
          return {
            type: "message",
            text: `answer ${number}`,
            toolCalls: [],
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        },
      };
    },
  };
  const f = fixture(provider);
  await f.run(EARLY);
  const controller = new AbortController();
  const compact = f.run("/compact", controller.signal);
  await entered;
  const next = f.run("next request");
  await Promise.resolve();
  expect(turns).toBe(2);
  controller.abort();
  expect((await compact).ok).toBe(false);
  expect((await next).ok).toBe(true);
  release({
    type: "message",
    text: "late summary",
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 10 },
  });
  await Promise.resolve();
  expect(latestCheckpoint(await f.history())).toBeUndefined();
  expect(
    (await f.history()).some((e) => e.type === "compaction.failed" && e.payload.cancelled),
  ).toBe(true);
});

it("refuses empty history and reserves turn spending for compaction", async () => {
  const emptyProvider = new ScriptedLLMProvider([[]]);
  const empty = fixture(emptyProvider);
  expect((await empty.run("/compact")).ok).toBe(false);
  expect(emptyProvider.requests).toHaveLength(0);
  const provider = new ScriptedLLMProvider([[{ text: "earlier answer" }], []]);
  const f = fixture(provider, 80_000, 3_000);
  await f.run(EARLY);
  expect((await f.run("/compact")).ok).toBe(false);
  expect(provider.requests.filter((r) => r.purpose === "compaction")).toHaveLength(0);
});

it("uses a native capability only when supplied, keeps portable history and accounts native usage once", async () => {
  const f = fixture(new ScriptedLLMProvider([[{ text: "prior work" }]]));
  await f.run(EARLY);
  const nativeRequests: Parameters<import("@nap/shared/ports/llm-provider").NativeCompaction>[0][] =
    [];
  const { NativeSessionLifecycle } = await import("@nap/agent/native-compaction");
  const lifecycle = new NativeSessionLifecycle(async (request) => {
    nativeRequests.push(request);
    return {
      provider: "codex",
      sessionId: "native-real-id",
      usage: { inputTokens: 1000, outputTokens: 100 },
      beforeTokens: 20000,
      afterTokens: 4000,
    };
  });
  const underlying = new ScriptedLLMProvider([[]]);
  const native: LLMProvider = {
    startTurn(options) {
      return lifecycle.bind(underlying.startTurn(options));
    },
  };
  const result = await f
    .restart(native)
    .runTurn({ turnId: crypto.randomUUID(), sessionId: SESSION, message: "/compact" });
  expect(result.ok).toBe(true);
  expect(underlying.requests).toHaveLength(0);
  expect(nativeRequests[0]?.trustedInstructions).not.toContain(EARLY);
  expect(nativeRequests[0]?.untrustedContext).toContain(EARLY);
  const history = await f.history();
  expect(latestCheckpoint(history)).toBeUndefined();
  expect(history.findLast((e) => e.type === "compaction.completed")?.payload).toMatchObject({
    result: { kind: "native", sessionId: "native-real-id" },
    beforeTokens: 20000,
    afterTokens: 4000,
  });
  expect(history.findLast((e) => e.type === "turn.completed")?.payload).toMatchObject({
    usage: { inputTokens: 1000, outputTokens: 100 },
  });
  expect(history.findLast((e) => e.type === "context.usage")?.payload).toMatchObject({
    inputTokens: 4000,
    source: "reported",
  });
});

it("refuses an oversized current request intact before making a normal model call", async () => {
  const provider = new ScriptedLLMProvider([[]]);
  const f = fixture(provider, 4000);
  const request = `${EARLY}${"x".repeat(20000)}`;
  const result = await f.run(request);
  expect(result).toMatchObject({ ok: false, reason: "budget_exceeded" });
  expect(provider.requests).toHaveLength(0);
  expect((await f.history()).find((e) => e.type === "user.message")?.payload).toEqual({
    text: request,
  });
});

it("rejects empty or truncated summaries without replacing a usable context", async () => {
  for (const summary of ["", "   "]) {
    const f = fixture(
      new ScriptedLLMProvider([[{ text: "previous answer" }], [{ text: summary }]]),
    );
    await f.run(EARLY);
    expect((await f.run("/compact")).ok).toBe(false);
    expect(latestCheckpoint(await f.history())).toBeUndefined();
  }
  const first = new ScriptedLLMProvider([[{ text: "previous answer" }]]);
  const f = fixture(first);
  await f.run(EARLY);
  const truncated: LLMProvider = {
    startTurn: () => ({
      usage: () => ({ inputTokens: 1, outputTokens: 1 }),
      complete: async () => ({
        type: "message",
        text: "incomplete summary",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        truncated: true,
      }),
    }),
  };
  expect(
    (
      await f
        .restart(truncated)
        .runTurn({ sessionId: SESSION, turnId: crypto.randomUUID(), message: "/compact" })
    ).ok,
  ).toBe(false);
  expect(latestCheckpoint(await f.history())).toBeUndefined();
});

it("successive checkpoints summarize only new exchanges and restart at the latest boundary", async () => {
  const provider = new ScriptedLLMProvider([
    [{ text: "first old exchange" }],
    [{ text: "first summary" }],
    [{ text: "second exchange" }],
    [{ text: "second summary" }],
  ]);
  const f = fixture(provider);
  await f.run(EARLY);
  await f.run("/compact");
  const first = latestCheckpoint(await f.history())!;
  await f.run("Keep filters accessible too");
  await f.run("/compact");
  const second = latestCheckpoint(await f.history())!;
  expect(second.coveredThrough).toBeGreaterThan(first.coveredThrough);
  const source = JSON.stringify(
    provider.requests.filter((r) => r.purpose === "compaction").at(-1)!.messages,
  );
  expect(source).toContain(first.summary);
  expect(source).toContain("second exchange");
  expect(source).not.toContain("first old exchange");
  const next = new ScriptedLLMProvider([[{ text: "done" }]]);
  await f
    .restart(next)
    .runTurn({ turnId: crypto.randomUUID(), sessionId: SESSION, message: "Finish the filter" });
  const replay = JSON.stringify(next.requests[0]!.messages);
  for (const text of [EARLY, "Keep filters accessible too", "Finish the filter", second.summary])
    expect(replay.split(text)).toHaveLength(2);
  expect(replay).not.toContain("second exchange");
  expect(replay).not.toContain(first.summary);
});

it("marks aggregate usage incomplete when native compaction supplied no usage", async () => {
  const f = fixture(new ScriptedLLMProvider([[{ text: "prior work" }]]));
  await f.run(EARLY);
  const provider: LLMProvider = {
    startTurn: () => ({
      usage: () => ({ inputTokens: 0, outputTokens: 0 }),
      complete: async () => {
        throw new Error("unexpected API request");
      },
      compact: async () => ({
        provider: "codex",
        sessionId: "native",
        usage: null,
        beforeTokens: null,
        afterTokens: null,
      }),
    }),
  };
  const result = await f
    .restart(provider)
    .runTurn({ sessionId: SESSION, turnId: crypto.randomUUID(), message: "/compact" });
  expect(result.ok).toBe(true);
  const history = await f.history();
  expect(history.findLast((e) => e.type === "compaction.completed")?.payload.usage).toBeNull();
  expect(history.findLast((e) => e.type === "turn.completed")?.payload).toHaveProperty(
    "usageIncomplete",
    true,
  );
});

describe("the compaction history", () => {
  const PATH = compactionHistoryPath(SESSION);
  const sandboxOf = async (f: ReturnType<typeof fixture>) => {
    const id = (await f.sessions.get(SESSION))?.sandboxId;
    if (id === null || id === undefined) throw new Error("the session has no sandbox");
    return id;
  };
  const historyFile = async (f: ReturnType<typeof fixture>) => {
    const read = await f.sandbox.readFile(await sandboxOf(f), PATH);
    return read.ok ? read.value : undefined;
  };

  it("keeps the replaced conversation in the sandbox and points the summary and later turns at it", async () => {
    const provider = new ScriptedLLMProvider([
      [{ text: "old assistant detail ".repeat(500) }],
      [{ text: "Overview\nThemed (#2)." }],
    ]);
    const f = fixture(provider);
    await f.run(EARLY);
    expect(await historyFile(f)).toBeUndefined();
    expect((await f.run("/compact")).ok).toBe(true);

    const file = await historyFile(f);
    expect(file).toBe(renderCompactionHistory(await f.history(), SESSION));
    expect(file).toContain(`    ${EARLY}`);
    expect(file).toContain("old assistant detail old assistant detail");
    const summarizing = provider.requests.find((r) => r.purpose === "compaction");
    expect(summarizing?.systemPrompt).toContain(PATH);
    expect(summarizing?.messages[0]?.content).toContain(`user\\n    ${EARLY}`);

    const next = new ScriptedLLMProvider([[{ text: "new answer" }]]);
    await f
      .restart(next)
      .runTurn({ turnId: crypto.randomUUID(), sessionId: SESSION, message: "Now add a filter" });
    const conversation = JSON.stringify(next.requests[0]?.messages);
    expect(conversation).toContain(PATH);
    expect(conversation).not.toContain("not available in this sandbox");
  });

  it("gives the summarizer the tool output of the turn a manual compaction follows", async () => {
    const provider = new ScriptedLLMProvider([
      [
        {
          toolCalls: [{ id: "r1", name: "read_file", input: { path: "/home/user/app/large.txt" } }],
        },
        { text: "Read it." },
      ],
      [{ text: "Overview\nRead (#3)." }],
    ]);
    const f = fixture(provider);
    await f.run(EARLY);
    expect((await f.run("/compact")).ok).toBe(true);
    const source = provider.requests.find((r) => r.purpose === "compaction")?.messages[0]?.content;
    expect(source).toContain("tool-output");
    expect(source).not.toContain("output not repeated here");
  });

  describe("in a sandbox that will not take the file", () => {
    /** The way the local computer harness behaves, which refuses anything outside the project. */
    class RefusingSandbox extends InMemorySandboxManager {
      override async writeFile(sandboxId: string, path: string, contents: string) {
        if (path.startsWith(`${COMPACTION_HISTORY_DIR}/`))
          return { ok: false as const, error: { code: "exec_failed" as const, message: "no" } };
        return super.writeFile(sandboxId, path, contents);
      }
    }

    it("still compacts on /compact, and the next turn is told the file is unavailable", async () => {
      const provider = new ScriptedLLMProvider([
        [{ text: "first answer" }],
        [{ text: "Overview\nDone (#2)." }],
        [{ text: "second answer" }],
      ]);
      const f = fixture(provider, 80_000, 400_000, RefusingSandbox);
      await f.run(EARLY);
      expect((await f.run("/compact")).ok).toBe(true);
      expect((await f.history()).some((e) => e.type === "compaction.completed")).toBe(true);
      await f.run("Now add a filter");
      const conversation = JSON.stringify(provider.requests.at(-1)?.messages);
      expect(conversation).toContain("not available in this sandbox");
      expect(conversation).not.toContain(PATH);
    });

    it("still compacts within a turn, and tells that same turn the file is unavailable", async () => {
      const { provider, requests } = readingModel();
      const f = fixture(provider, 24_000, 400_000, RefusingSandbox);
      expect((await f.run(EARLY)).ok).toBe(true);
      const history = await f.history();
      const completed = history.findIndex((e) => e.type === "compaction.completed");
      expect(completed).toBeGreaterThan(-1);
      expect(history.findLastIndex((e) => e.type === "tool.result")).toBeGreaterThan(completed);
      const conversation = JSON.stringify(
        requests.filter((r) => r.purpose !== "compaction").at(-1)?.messages,
      );
      expect(conversation).toContain("not available in this sandbox");
      expect(conversation).not.toContain(PATH);
    });
  });

  it("adds a part at each compaction without rewriting the earlier ones", async () => {
    const f = fixture(
      new ScriptedLLMProvider([
        [{ text: "first answer" }],
        [{ text: "first summary" }],
        [{ text: "second answer" }],
        [{ text: "second summary" }],
      ]),
    );
    await f.run(EARLY);
    await f.run("/compact");
    const first = await historyFile(f);
    await f.run("Add a filter");
    expect(await historyFile(f)).toBe(first);
    await f.run("/compact");
    const second = await historyFile(f);
    expect(second?.startsWith(first ?? "missing")).toBe(true);
    expect(second?.slice(first?.length)).toMatch(/==== Part 2: events #\d+ to #\d+ ====/);
    expect(second?.slice(first?.length)).toContain("    Add a filter");
    expect(second?.slice(first?.length)).not.toContain(EARLY);
  });

  it("regenerates the file from events when the project comes back in a new sandbox", async () => {
    const f = fixture(
      new ScriptedLLMProvider([[{ text: "first answer" }], [{ text: "first summary" }]]),
    );
    await f.run(EARLY);
    await f.run("/compact");
    const original = await historyFile(f);
    const before = await sandboxOf(f);
    await f.sandbox.destroy(before);

    const next = new ScriptedLLMProvider([[{ text: "resumed" }]]);
    const outcome = await f
      .restart(next, true)
      .runTurn({ turnId: crypto.randomUUID(), sessionId: SESSION, message: "Carry on" });
    expect(outcome).toMatchObject({ ok: true });
    expect(await sandboxOf(f)).not.toBe(before);
    expect(await historyFile(f)).toBe(original);
    expect(JSON.stringify(next.requests[0]?.messages)).toContain(PATH);
  });

  it("leaves native compaction's history to the native session", async () => {
    const f = fixture(new ScriptedLLMProvider([[{ text: "prior work" }]]));
    await f.run(EARLY);
    const { NativeSessionLifecycle } = await import("@nap/agent/native-compaction");
    const lifecycle = new NativeSessionLifecycle(async () => ({
      provider: "claude",
      sessionId: "native-session",
      usage: { inputTokens: 1, outputTokens: 1 },
      beforeTokens: null,
      afterTokens: null,
    }));
    const underlying = new ScriptedLLMProvider([[]]);
    const native: LLMProvider = {
      startTurn: (options) => lifecycle.bind(underlying.startTurn(options)),
    };
    const result = await f
      .restart(native)
      .runTurn({ turnId: crypto.randomUUID(), sessionId: SESSION, message: "/compact" });
    expect(result.ok).toBe(true);
    expect(await historyFile(f)).toBeUndefined();
  });
});
