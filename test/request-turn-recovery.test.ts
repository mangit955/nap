import { completedTurn, ScriptedAgent } from "@nap/agent/testing/scripted-agent";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { StubContextEngine } from "@nap/context/testing/stub-context-engine";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { FAKE_COMMIT_SHA, scriptGit } from "@nap/sandbox/testing/script-git";
import { NapEventSchema } from "@nap/shared/events";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { foldJobs, openJob } from "@nap/shared/job-state";
import { LEASE_GRACE_MS, LEASE_TTL_MS } from "@nap/shared/lease-windows";
import type { EventStore, PendingEvent } from "@nap/shared/ports/event-store";
import { expect, it, vi } from "vitest";
import { buildTranscript } from "../apps/web/src/chat/transcript.ts";
import { inFlightTurn } from "../apps/web/src/chat/working-state.ts";
import { InMemoryEventBus } from "../packages/db/src/testing/in-memory-event-bus.ts";
import { InMemoryEventStore } from "../packages/db/src/testing/in-memory-event-store.ts";
import { InMemorySessionStore } from "../packages/db/src/testing/in-memory-session-store.ts";
import { InMemoryTurnQueue } from "../packages/db/src/testing/in-memory-turn-queue.ts";
import { sweepOrphanedRequests } from "../packages/runtime/src/janitor.ts";
import { SingleAgentRuntime } from "../packages/runtime/src/single-agent-runtime.ts";
import { startTurnWorker } from "../packages/runtime/src/turn-worker.ts";

const SESSION = "00000000-0000-4000-8000-000000000001";
const REQUEST = "00000000-0000-4000-8000-000000000002";
const REPAIR = "00000000-0000-4000-8000-000000000003";
const ORIGINAL = "00000000-0000-4000-8000-000000000004";
const JOB = "00000000-0000-4000-8000-000000000005";
const NEXT = "00000000-0000-4000-8000-000000000006";
const PROJECT = "00000000-0000-4000-8000-000000000007";
const NEXT_REPAIR = "00000000-0000-4000-8000-000000000008";
const TEXT = "Build the dashboard";
const attachments = [
  {
    kind: "image" as const,
    name: "dashboard.jpg",
    frames: [{ timestamp: 0, mediaType: "image/jpeg" as const, data: "AAAA" }],
  },
];
const envelope = {
  sessionId: SESSION,
  turnId: ORIGINAL,
  createdAt: "2026-10-19T00:00:00.000Z",
};
const completed = {
  usage: { inputTokens: 1, outputTokens: 1 },
  durationMs: 1,
  commitSha: FAKE_COMMIT_SHA,
};

function request(kind: "turn" | "resume") {
  return {
    id: REQUEST,
    sessionId: SESSION,
    userId: "owner",
    kind,
    message: kind === "turn" ? TEXT : null,
    ...(kind === "turn" ? { attachments } : {}),
    target: { kind: "api" as const, model: "fixture/free", billsToUser: false },
  };
}

// Resume starts with an old job, whose original user prompt is distinct from the new lease.
const resumable: PendingEvent[] = [
  { ...envelope, type: "user.message", payload: { text: TEXT, attachments } },
  { ...envelope, type: "job.started", payload: { jobId: JOB, objective: TEXT } },
  { ...envelope, type: "turn.started", payload: { source: "user" } },
  { ...envelope, type: "turn.completed", payload: completed },
  { ...envelope, type: "verification.started", payload: { jobId: JOB } },
  {
    ...envelope,
    type: "verification.completed",
    payload: {
      jobId: JOB,
      checks: [{ name: "typecheck", outcome: "failed", output: "type error" }],
    },
  },
];

/** Records the real worker/runtime's log; recovery replays its exact durable prefix. */
async function produced(kind: "turn" | "resume") {
  const events = new InMemoryEventStore();
  const queue = new InMemoryTurnQueue();
  if (kind === "resume") for (const event of resumable) await events.append(event);
  const sandbox = scriptGit(
    new InMemorySandboxManager({
      serves: [TEMPLATE_DEV_PORT],
      seed: {
        [`${PROJECT_ROOT_PATH}/package.json`]: JSON.stringify({ scripts: { typecheck: "tsc" } }),
      },
    }),
  ).script(/bun run typecheck/, { exitCode: 1, stderr: "type error" });
  const agent = new ScriptedAgent((turn) =>
    completedTurn(turn.promptSource === "verification" ? null : FAKE_COMMIT_SHA),
  );
  const runtime = new SingleAgentRuntime({
    sessions: new InMemorySessionStore([{ sessionId: SESSION, projectId: PROJECT }]),
    sandbox,
    agent,
    context: new StubContextEngine(),
    memory: new NoopMemoryProvider(),
    events,
    bus: new InMemoryEventBus(),
    newTurnId: () => REPAIR,
  });
  await queue.enqueue(request(kind));
  const worker = startTurnWorker({ queue, runtime, concurrency: 1, pollIntervalMs: 1 });
  try {
    await vi.waitFor(() => expect(queue.stateOf(REQUEST)).toBe("done"));
  } finally {
    await worker.stop();
  }
  const log = await events.readFrom(SESSION, 0);
  expect(agent.requests.filter((turn) => turn.promptSource === "verification")).toHaveLength(1);
  expect(log.some((event) => event.turnId === REPAIR && event.type === "turn.completed")).toBe(
    true,
  );
  for (const event of log)
    expect(NapEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  return log;
}

type Boundary = "prompt" | "started" | "completed";
async function fixture(kind: "turn" | "resume" = "turn", boundary: Boundary = "started") {
  const log = await produced(kind);
  const eventType = boundary === "prompt" ? "user.message" : `turn.${boundary}`;
  const end = log.findIndex((event) => event.turnId === REPAIR && event.type === eventType);
  expect(end).toBeGreaterThan(-1);
  const prefix = log.slice(0, end + 1);
  let now = Date.parse(envelope.createdAt);
  const queue = new InMemoryTurnQueue({ now: () => now });
  const events = new InMemoryEventStore();
  for (const { seq: _seq, ...event } of prefix) await events.append(event);
  await queue.enqueue(request(kind));
  expect((await queue.claim("interrupted-worker"))?.id).toBe(REQUEST);
  now += LEASE_TTL_MS + LEASE_GRACE_MS + 1;
  const bus = new InMemoryEventBus();
  const sweep = (store: EventStore = events) =>
    sweepOrphanedRequests({
      queue,
      events: store,
      bus,
      now: () => new Date(now).toISOString(),
    });
  return { events, queue, prefix, sweep, history: () => events.readFrom(SESSION, 0) };
}

it.each(
  (["turn", "resume"] as const).flatMap((kind) =>
    (["prompt", "started", "completed"] as const).map((boundary) => ({ kind, boundary })),
  ),
)(
  "recovers the actual $kind producer at repair $boundary without replaying work",
  async ({ kind, boundary }) => {
    const f = await fixture(kind, boundary);
    const prompt = f.prefix.find(
      (event) => event.turnId === REPAIR && event.type === "user.message",
    );
    expect(prompt).toMatchObject({ payload: { repair: { requestId: REQUEST } } });
    const job = f.prefix.find((event) => event.type === "job.started");
    expect(prompt?.type === "user.message" && prompt.payload.repair?.jobId).toBe(
      job?.type === "job.started" ? job.payload.jobId : undefined,
    );
    expect((await f.sweep()).announced).toEqual([REQUEST]);
    const recovered = await f.history();
    expect(recovered.slice(0, f.prefix.length)).toEqual(f.prefix);
    const suffix = recovered.slice(f.prefix.length);
    expect(suffix.map((event) => [event.type, event.turnId])).toEqual(
      boundary === "completed"
        ? [["system.notice", REQUEST]]
        : [
            ["turn.failed", REPAIR],
            ["system.notice", REQUEST],
          ],
    );
    expect(inFlightTurn(recovered)).toBeUndefined();
    expect(openJob(foldJobs(recovered))).toBeDefined();
    if (boundary !== "completed") {
      const failure = buildTranscript(recovered).findLast((item) => item.kind === "turn-end");
      expect(failure).toMatchObject({
        outcome: "failed",
        retryMessage: TEXT,
        retryAttachments: attachments,
      });
    }
    for (const event of recovered) expect(NapEventSchema.safeParse(event).success).toBe(true);
    expect(await f.queue.unannouncedOrphans()).toEqual([]);
    expect(await f.queue.requestCancel(SESSION)).toEqual({ cancelled: false });
    expect(await f.queue.claim("next-worker")).toBeNull();
    expect(await f.sweep()).toEqual({ orphaned: [], announced: [], failed: [] });
    expect(await f.history()).toEqual(recovered);
  },
);

it.each(
  (["turn.failed", "system.notice"] as const).flatMap((type) =>
    [false, true].map((committed) => ({ type, committed })),
  ),
)(
  "finishes repair recovery after $type append failure, committed=$committed",
  async ({ type, committed }) => {
    const f = await fixture();
    const interrupted: EventStore = {
      readFrom: (sessionId, seq) => f.events.readFrom(sessionId, seq),
      append: async (event, options) => {
        if (event.type !== type) return f.events.append(event, options);
        if (committed) await f.events.append(event, options);
        throw new Error("append acknowledgement lost");
      },
    };
    expect((await f.sweep(interrupted)).failed).toHaveLength(1);
    expect(await f.queue.unannouncedOrphans()).toHaveLength(1);
    expect((await f.sweep()).announced).toEqual([REQUEST]);
    const suffix = (await f.history()).slice(f.prefix.length);
    expect(suffix.map((event) => [event.type, event.turnId])).toEqual([
      ["turn.failed", REPAIR],
      ["system.notice", REQUEST],
    ]);
    expect(inFlightTurn(await f.history())).toBeUndefined();
  },
);

it("retries a failed ownership read and announcement mark without changing durable endings", async () => {
  const f = await fixture("resume", "prompt");
  expect(
    (
      await f.sweep({
        readFrom: async () => {
          throw new Error("read lost");
        },
        append: f.events.append.bind(f.events),
      })
    ).failed,
  ).toHaveLength(1);
  expect(await f.history()).toEqual(f.prefix);
  vi.spyOn(f.queue, "markOrphanAnnounced").mockRejectedValueOnce(new Error("mark lost"));
  expect((await f.sweep()).failed).toHaveLength(1);
  const durable = await f.history();
  expect((await f.sweep()).announced).toEqual([REQUEST]);
  expect(await f.history()).toEqual(durable);
});

function gate() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

it.each(["user", "verification", "manual"] as const)(
  "does not end newer %s work when a delayed janitor repeats the old repair terminal",
  async (kind) => {
    const f = await fixture();
    const job = f.prefix.find((event) => event.type === "job.started");
    if (job === undefined) throw new Error("the producer did not open a job");
    await f.queue.orphanExpired();
    const read = gate();
    const resume = gate();
    const late = f.sweep({
      readFrom: async (sessionId, seq) => {
        const snapshot = await f.events.readFrom(sessionId, seq);
        read.release();
        await resume.ready;
        return snapshot;
      },
      append: async (event, options) => {
        if (event.type === "system.notice") throw new Error("late notice lost");
        return f.events.append(event, options);
      },
    });
    try {
      await read.ready;
      expect((await f.sweep()).announced).toEqual([REQUEST]);
      await f.queue.enqueue(
        kind === "verification"
          ? { ...request("resume"), id: NEXT }
          : { ...request("turn"), id: NEXT, message: kind === "manual" ? "/compact" : "New work" },
      );
      expect((await f.queue.claim("new-worker"))?.id).toBe(NEXT);
      const current = {
        ...envelope,
        turnId: kind === "verification" ? NEXT_REPAIR : NEXT,
        createdAt: "2026-10-19T00:02:00.000Z",
      };
      if (kind === "manual")
        await f.events.append({
          ...current,
          type: "compaction.started",
          payload: { id: NEXT, trigger: "manual" },
        });
      else {
        await f.events.append({
          ...current,
          type: "user.message",
          payload: {
            text: "New work",
            ...(kind === "verification"
              ? { repair: { requestId: NEXT, jobId: job.payload.jobId } }
              : {}),
          },
        });
        await f.events.append({ ...current, type: "turn.started", payload: { source: kind } });
      }
    } finally {
      resume.release();
      await late;
    }
    expect((await late).failed).toHaveLength(1);
    expect(inFlightTurn(await f.history())).toEqual({
      turnId: kind === "verification" ? NEXT_REPAIR : NEXT,
      startedAt: "2026-10-19T00:02:00.000Z",
      openedAt: "2026-10-19T00:02:00.000Z",
    });
    expect(await f.queue.unannouncedOrphans()).toEqual([]);
    expect(f.queue.stateOf(NEXT)).toBe("leased");
  },
);

it("preserves a legacy initial terminal and never guesses a legacy child's request", async () => {
  const f = await fixture();
  const legacy = new InMemoryEventStore();
  for (const { seq: _seq, ...event } of f.prefix) {
    await legacy.append(
      event.type === "user.message" ? { ...event, payload: { text: event.payload.text } } : event,
    );
  }
  expect((await f.sweep(legacy)).announced).toEqual([REQUEST]);
  const log = await legacy.readFrom(SESSION, 0);
  expect(log.slice(f.prefix.length).map((event) => event.type)).toEqual(["system.notice"]);
  // With no owner recorded, this could be a newer resume's repair. Closing it would be unsafe.
  expect(inFlightTurn(log)?.turnId).toBe(REPAIR);
});

it("persists repair ownership before starting fallible context preparation", async () => {
  const events = new InMemoryEventStore();
  for (const event of resumable) await events.append(event);
  const entered = gate();
  const release = gate();
  const context = new StubContextEngine();
  const agent = new ScriptedAgent(() => completedTurn(null));
  const runtime = new SingleAgentRuntime({
    sessions: new InMemorySessionStore([{ sessionId: SESSION, projectId: PROJECT }]),
    sandbox: scriptGit(new InMemorySandboxManager({ serves: [TEMPLATE_DEV_PORT] })),
    context,
    agent,
    memory: new NoopMemoryProvider(),
    bus: new InMemoryEventBus(),
    newTurnId: () => REPAIR,
    events: {
      readFrom: (sessionId, seq) => events.readFrom(sessionId, seq),
      append: async (event, options) => {
        if (event.turnId === REPAIR && event.type === "user.message") {
          entered.release();
          await release.ready;
        }
        return events.append(event, options);
      },
    },
  });
  const running = runtime.resumeSession(SESSION, { turnId: REQUEST });
  try {
    await entered.ready;
    expect(context.requests).toEqual([]);
    expect(agent.calls).toBe(0);
    expect((await events.readFrom(SESSION, 0)).some((event) => event.turnId === REPAIR)).toBe(
      false,
    );
  } finally {
    release.release();
    await running;
  }
  const prompt = (await events.readFrom(SESSION, 0)).find(
    (event) => event.turnId === REPAIR && event.type === "user.message",
  );
  expect(prompt).toMatchObject({ payload: { repair: { requestId: REQUEST, jobId: JOB } } });
  expect(context.requests).toHaveLength(1);
});

it.each(["turn", "resume"] as const)(
  "ends the owned repair when %s context preparation throws",
  async (kind) => {
    const events = new InMemoryEventStore();
    if (kind === "resume") for (const event of resumable) await events.append(event);
    const context = new StubContextEngine();
    const agent = new ScriptedAgent(() => completedTurn(FAKE_COMMIT_SHA));
    const runtime = new SingleAgentRuntime({
      sessions: new InMemorySessionStore([{ sessionId: SESSION, projectId: PROJECT }]),
      sandbox: scriptGit(
        new InMemorySandboxManager({
          serves: [TEMPLATE_DEV_PORT],
          seed: {
            [`${PROJECT_ROOT_PATH}/package.json`]: JSON.stringify({
              scripts: { typecheck: "tsc" },
            }),
          },
        }),
      ).script(/bun run typecheck/, { exitCode: 1, stderr: "type error" }),
      context: {
        build: async (input) => {
          if (input.job?.attempts.length) throw new Error("context unavailable");
          return context.build(input);
        },
      },
      agent,
      memory: new NoopMemoryProvider(),
      events,
      bus: new InMemoryEventBus(),
      newTurnId: () => REPAIR,
    });
    if (kind === "resume") await runtime.resumeSession(SESSION, { turnId: REQUEST });
    else await runtime.runTurn({ sessionId: SESSION, turnId: REQUEST, message: TEXT, attachments });
    const log = await events.readFrom(SESSION, 0);
    expect(log.filter((event) => event.type === "turn.failed")).toEqual([
      expect.objectContaining({
        turnId: REPAIR,
        payload: { reason: "internal", message: "context unavailable" },
      }),
    ]);
    expect(inFlightTurn(log)).toBeUndefined();
    expect(openJob(foldJobs(log))).toBeUndefined();
    expect(agent.calls).toBe(kind === "resume" ? 0 : 1);
  },
);

it("excludes a newer same-job repair already present before the janitor reads history", async () => {
  const f = await fixture();
  const job = f.prefix.find((event) => event.type === "job.started");
  if (job === undefined) throw new Error("missing produced job");
  await f.queue.orphanExpired();
  await f.queue.enqueue({ ...request("resume"), id: NEXT });
  expect((await f.queue.claim("new-worker"))?.id).toBe(NEXT);
  const current = { ...envelope, turnId: NEXT_REPAIR, createdAt: "2026-10-19T00:02:00.000Z" };
  await f.events.append({
    ...current,
    type: "user.message",
    payload: {
      text: "Repair the same job",
      repair: { requestId: NEXT, jobId: job.payload.jobId },
    },
  });
  await f.events.append({ ...current, type: "turn.started", payload: { source: "verification" } });
  const before = await f.history();
  expect((await f.sweep()).announced).toEqual([REQUEST]);
  const after = await f.history();
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.slice(before.length).map((event) => [event.type, event.turnId])).toEqual([
    ["turn.failed", REPAIR],
    ["system.notice", REQUEST],
  ]);
  expect(f.queue.stateOf(NEXT)).toBe("leased");
  expect(inFlightTurn(after)).toEqual({
    turnId: NEXT_REPAIR,
    startedAt: current.createdAt,
    openedAt: current.createdAt,
  });
});
