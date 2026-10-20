import { NapAgentService } from "@nap/agent/agent-service";
import { codexCompaction } from "@nap/agent/native-compaction";
import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { scriptGit } from "@nap/sandbox/testing/script-git";
import { latestCheckpoint } from "@nap/shared/compaction";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type { LLMProvider, LLMRequest } from "@nap/shared/ports/llm-provider";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { describe, expect, it, vi } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";

const SESSION = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-000000000002";
const EARLY = "Never deploy. Keep keyboard navigation and the purple theme.";
const envelope = { sessionId: SESSION, createdAt: "2026-10-19T00:00:00.000Z" };

function fixture(
  options: {
    provider?: LLMProvider;
    budgetTokens?: number;
    maxTokens?: number;
    maxSteps?: number;
    lostSandbox?: boolean;
  } = {},
) {
  const events = new InMemoryEventStore();
  const sessions = new InMemorySessionStore([
    { sessionId: SESSION, projectId: PROJECT, sandboxId: options.lostSandbox ? "gone" : null },
  ]);
  const sandbox = scriptGit(new InMemorySandboxManager({ serves: [5173] }), { dirty: false });
  const context = new NapContextEngine({ budgetTokens: options.budgetTokens ?? 80_000 });
  const provider =
    options.provider ?? new ScriptedLLMProvider([[{ text: "summary" }], [{ text: "done" }]]);
  const runtime = new SingleAgentRuntime({
    events,
    sessions,
    sandbox,
    context,
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
    agent: new NapAgentService({
      provider,
      budget: { maxTokens: options.maxTokens ?? 400_000, maxSteps: options.maxSteps ?? 24 },
    }),
    objects: new InMemoryObjectStore(),
    snapshots: new InMemorySnapshotStore(),
  });
  const append = (event: Omit<PendingEvent, "sessionId" | "createdAt">) =>
    events.append({ ...envelope, ...event } as PendingEvent);
  const exchange = async (text: string) => {
    const turnId = crypto.randomUUID();
    await append({ turnId, type: "user.message", payload: { text } });
    await append({ turnId, type: "agent.message", payload: { text: "OK" } });
    await append({
      turnId,
      type: "turn.completed",
      payload: { usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1, commitSha: null },
    });
  };
  const run = (message: string, signal?: AbortSignal) =>
    runtime.runTurn({
      sessionId: SESSION,
      turnId: crypto.randomUUID(),
      message,
      model: "openai/gpt-5.6-luna",
      ...(signal === undefined ? {} : { signal }),
    });
  return {
    events,
    sessions,
    sandbox,
    context,
    runtime,
    provider,
    append,
    exchange,
    run,
    history: () => events.readFrom(SESSION, 0),
  };
}

describe("compaction recovery regressions", () => {
  it.each([false, true])(
    "preserves every request after summary failure or rejection, checkpoint=%s",
    async (checkpoint) => {
      for (const mode of ["failure", "no-improvement"] as const) {
        const requests: LLMRequest[] = [];
        const provider: LLMProvider = {
          startTurn: () => ({
            usage: () => ({ inputTokens: 0, outputTokens: 0 }),
            async complete(request) {
              requests.push(request);
              if (request.purpose === "compaction" && mode === "failure")
                return {
                  type: "error",
                  message: "summary unavailable",
                  retryable: false,
                  usage: { inputTokens: 0, outputTokens: 0 },
                };
              return {
                type: "message",
                text: request.purpose === "compaction" ? "summary ".repeat(1500) : "done",
                toolCalls: [],
                usage: { inputTokens: 0, outputTokens: 0 },
              };
            },
          }),
        };
        const f = fixture({ provider });
        if (checkpoint) {
          await f.exchange("Keep the existing app.");
          const coveredThrough = (await f.history()).at(-1)!.seq;
          await f.append({
            turnId: crypto.randomUUID(),
            type: "compaction.completed",
            payload: {
              id: crypto.randomUUID(),
              result: {
                kind: "api",
                checkpoint: { coveredThrough, summary: "old summary", tail: [] },
              },
              beforeTokens: 100,
              afterTokens: 50,
              usage: null,
            },
          });
        }
        const original = [EARLY, ...Array.from({ length: 20 }, (_, i) => `Follow-up number ${i}.`)];
        for (const text of original) await f.exchange(text);
        expect((await f.run("Add a filter.")).ok).toBe(true);
        expect((await f.history()).some((event) => event.type === "compaction.failed")).toBe(true);
        const normal = requests.filter((request) => request.purpose !== "compaction");
        expect(normal).toHaveLength(1);
        const userMessages = JSON.stringify(
          normal[0]!.messages.filter((message) => message.role === "user"),
        );
        for (const text of [...original, "Add a filter."])
          expect(userMessages.split(text)).toHaveLength(2);
      }
    },
  );

  it.each([
    { maxSteps: 1, maxTokens: 400_000 },
    { maxSteps: 24, maxTokens: 3_000 },
  ])("stops when protected history cannot fit even without summary budget: %j", async (budget) => {
    const provider = new ScriptedLLMProvider([[{ text: "should not be requested" }]]);
    const f = fixture({ provider, budgetTokens: 4_000, ...budget });
    await f.exchange(`${EARLY}${"x".repeat(20_000)}`);
    for (let i = 0; i < 20; i++) await f.exchange(`Follow-up ${i}`);
    expect(await f.run("Continue.")).toMatchObject({ ok: false, reason: "budget_exceeded" });
    expect(provider.requests.filter((request) => request.purpose !== "compaction")).toHaveLength(0);
  });

  it("closes the durable manual identity when Stop arrives during context preparation", async () => {
    const controller = new AbortController();
    const f = fixture();
    await f.exchange(EARLY);
    const build = f.context.build.bind(f.context);
    vi.spyOn(f.context, "build").mockImplementation(async (request) => {
      const result = await build(request);
      controller.abort();
      return result;
    });
    const outcome = await f.run("/compact", controller.signal);
    expect(outcome).toMatchObject({ ok: false, reason: "cancelled" });
    const events = (await f.history()).filter((event) => event.turnId === outcome.turnId);
    const start = events.find((event) => event.type === "compaction.started")!;
    expect(events.filter((event) => event.type === "compaction.started")).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "compaction.failed",
        payload: expect.objectContaining({ id: start.payload.id, cancelled: true }),
      }),
    );
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.type === "user.message" ||
          event.type === "job.started" ||
          event.type === "compaction.completed",
      ),
    ).toBe(false);
  });

  it.each(["empty", "unfinished", "acquisition", "context"] as const)(
    "records manual identity before %s preparation fails",
    async (failure) => {
      const f = fixture({ lostSandbox: failure === "acquisition" });
      if (failure === "acquisition" || failure === "context")
        await f.exchange("Build the dashboard.");
      if (failure === "unfinished")
        await f.append({
          turnId: crypto.randomUUID(),
          type: "user.message",
          payload: {
            text: "Previous unfinished work",
            attachments: [
              {
                kind: "image",
                name: "old.jpg",
                frames: [{ timestamp: 0, mediaType: "image/jpeg", data: "AAAA" }],
              },
            ],
          },
        });
      if (failure === "acquisition")
        vi.spyOn(f.sandbox, "create").mockResolvedValue({
          ok: false,
          error: { code: "unavailable", message: "No capacity" },
        });
      if (failure === "context")
        vi.spyOn(f.context, "build").mockRejectedValue(new Error("file listing unavailable"));
      const before = await f.history();
      const outcome = await f.run("/compact");
      expect(outcome.ok).toBe(false);
      const added = (await f.history()).slice(before.length);
      expect(added[0]).toMatchObject({
        type: "compaction.started",
        payload: { trigger: "manual" },
      });
      const start = added.find((event) => event.type === "compaction.started")!;
      expect(added.filter((event) => event.type === "compaction.started")).toHaveLength(1);
      expect(added).toContainEqual(
        expect.objectContaining({
          type: "compaction.failed",
          payload: expect.objectContaining({ id: start.payload.id, cancelled: false }),
        }),
      );
      expect(
        added.some((event) => event.type === "user.message" || event.type === "job.started"),
      ).toBe(false);
      expect(latestCheckpoint(await f.history())).toBeUndefined();
    },
  );

  it("publishes lost workspace recovery and replacement preview through the next ordinary turn", async () => {
    const f = fixture({ lostSandbox: true });
    await f.exchange(EARLY);
    await f.append({
      turnId: crypto.randomUUID(),
      type: "preview.ready",
      payload: { url: "https://gone.example", port: 5173 },
    });
    const result = await f.run("/compact");
    expect(result).toMatchObject({ ok: true, commitSha: null });
    const compactEvents = (await f.history()).filter((event) => event.turnId === result.turnId);
    expect(compactEvents.some((event) => event.type === "system.notice")).toBe(true);
    const preview = compactEvents.find((event) => event.type === "preview.ready");
    expect(preview).toBeDefined();
    expect(preview?.payload.url).not.toBe("https://gone.example");
    expect(compactEvents.filter((event) => event.type === "compaction.started")).toHaveLength(1);
    expect(
      compactEvents.some((event) => event.type === "user.message" || event.type === "job.started"),
    ).toBe(false);
    expect((await f.run("Continue.")).ok).toBe(true);
    expect((await f.history()).findLast((event) => event.type === "preview.ready")).toEqual(
      preview,
    );
  });

  it("restores native reference metadata without sending attachment or image bytes to inject_items", async () => {
    let notify: (message: unknown) => void = () => {};
    let injected: unknown;
    const compact = codexCompaction({
      sessionId: "native",
      subscribe(listener) {
        notify = listener;
        return () => {};
      },
      async interrupt() {},
      async request(method, params) {
        if (method === "thread/inject_items") {
          injected = params;
          return;
        }
        notify({ method: "turn/started", params: { threadId: "native", turn: { id: "t" } } });
        notify({
          method: "item/completed",
          params: { threadId: "native", turnId: "t", item: { type: "contextCompaction" } },
        });
        notify({
          method: "turn/completed",
          params: { threadId: "native", turn: { id: "t", status: "completed" } },
        });
      },
    });
    const provider: LLMProvider = {
      startTurn: () => ({
        compact,
        usage: () => ({ inputTokens: 0, outputTokens: 0 }),
        complete: async () => {
          throw new Error("unexpected API call");
        },
      }),
    };
    const f = fixture({ provider });
    const turnId = crypto.randomUUID();
    const data = "U0VDUkVUSU1BR0VCWVRFUw==";
    await f.append({
      turnId,
      type: "user.message",
      payload: {
        text: "Use this reference",
        attachments: [
          {
            kind: "video",
            name: "walkthrough.mp4",
            duration: 8,
            frames: [{ timestamp: 1.5, mediaType: "image/jpeg", data }],
          },
        ],
      },
    });
    await f.append({ turnId, type: "agent.message", payload: { text: "Observed the reference" } });
    const before = await f.history();
    expect((await f.run("/compact")).ok).toBe(true);
    const payload = JSON.stringify(injected);
    expect(payload).not.toContain(data);
    for (const text of ["walkthrough.mp4", "video", "1.5", "Use this reference"])
      expect(payload).toContain(text);
    expect((await f.history()).slice(0, before.length)).toEqual(before);
  });
});
