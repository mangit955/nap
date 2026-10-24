import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { FAKE_OWNER, InMemoryProjectStore } from "@nap/db/testing/in-memory-project-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemoryTurnQueue } from "@nap/db/testing/in-memory-turn-queue";
import { sweepOrphanedRequests } from "@nap/runtime/janitor";
import { LEASE_GRACE_MS, LEASE_TTL_MS } from "@nap/shared/lease-windows";
import type { EventStore, PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import { SessionActivitySchema } from "@nap/shared/ports/turn-queue";
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../../../api/src/app.ts";
import { createLogger } from "../../../api/src/logger.ts";
import { TurnRegistry } from "../../../api/src/turns/registry.ts";
import { useTurnSubmission } from "./use-turn-submission.ts";

afterEach(() => vi.useRealTimers());

function api(queue: InMemoryTurnQueue, store: EventStore) {
  const sessions = new InMemorySessionStore([{ sessionId: SESSION, projectId: "project" }]);
  return createApp({
    logger: createLogger({ level: "silent" }, { write: () => {} }),
    authenticate: async () => ({ userId: FAKE_OWNER, isAnonymous: false }),
    stream: {
      store,
      bus: new InMemoryEventBus(),
      sessions,
      upgradeWebSocket: async () => new Response(null),
    },
    turns: {
      queue,
      sessions,
      projects: new InMemoryProjectStore(),
      registry: new TurnRegistry(),
      allowedModels: ["fixture/free"],
      freeModel: "fixture/free",
      defaultModel: "fixture/free",
    },
  });
}

async function refresh() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
}

// Prepared, not executed. These are synthetic durable traces of the inspected producer paths.
// The first suffix is the old janitor's actual contract, already exercised by historical V032.
const SESSION = "00000000-0000-4000-8000-000000000001";
const REQUEST = "00000000-0000-4000-8000-000000000002";
const REPAIR = "00000000-0000-4000-8000-000000000003";
const NEXT = "00000000-0000-4000-8000-000000000004";
const CHILD = "00000000-0000-4000-8000-000000000005";
const JOB = "00000000-0000-4000-8000-000000000006";
const NEXT_JOB = "00000000-0000-4000-8000-000000000007";
const completed = {
  usage: { inputTokens: 1, outputTokens: 1 },
  durationMs: 1,
  commitSha: "abc123",
};
const cases = [
  "historical-only",
  "later-user-completed",
  "later-resume-completed",
  "later-resume-cancelled",
  "later-resume-active",
] as const;

it.each(cases)("reconciles already-announced legacy repair activity: %s", async (scenario) => {
  vi.useFakeTimers();
  let now = Date.parse("2026-10-19T00:00:00.000Z");
  const queue = new InMemoryTurnQueue({ now: () => now });
  const events = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const original = { sessionId: SESSION, turnId: REQUEST, createdAt: new Date(now).toISOString() };
  const repair = { ...original, turnId: REPAIR, createdAt: new Date(now + 1000).toISOString() };
  await queue.enqueue({
    id: REQUEST,
    sessionId: SESSION,
    userId: "owner",
    kind: "turn",
    message: "Build the dashboard",
    target: { kind: "api", model: "fixture/free", billsToUser: false },
  });
  expect((await queue.claim("old-worker"))?.id).toBe(REQUEST);
  const prefix: PendingEvent[] = [
    { ...original, type: "user.message", payload: { text: "Build the dashboard" } },
    { ...original, type: "job.started", payload: { jobId: JOB, objective: "Build the dashboard" } },
    { ...original, type: "turn.started", payload: { source: "user" } },
    { ...original, type: "turn.completed", payload: completed },
    { ...original, type: "verification.started", payload: { jobId: JOB } },
    {
      ...original,
      type: "verification.completed",
      payload: {
        jobId: JOB,
        checks: [{ name: "typecheck", outcome: "failed", output: "type error" }],
      },
    },
    { ...repair, type: "user.message", payload: { text: "Repair the failed typecheck" } },
    { ...repair, type: "turn.started", payload: { source: "verification" } },
  ];
  for (const event of prefix) await events.append(event);
  now += LEASE_TTL_MS + LEASE_GRACE_MS + 1;
  expect((await queue.orphanExpired()).map((request) => request.id)).toEqual([REQUEST]);
  // Replay an announcement made before upgrade, without asking today's janitor to synthesize it.
  await events.append({
    ...original,
    createdAt: new Date(now).toISOString(),
    type: "turn.failed",
    payload: { reason: "internal", message: "worker interrupted" },
  });
  await events.append({
    ...original,
    createdAt: new Date(now).toISOString(),
    type: "system.notice",
    payload: { level: "warning", text: "Reopen the project" },
  });
  await queue.markOrphanAnnounced(REQUEST);

  if (scenario !== "historical-only") {
    const isUser = scenario === "later-user-completed";
    await queue.enqueue({
      id: NEXT,
      sessionId: SESSION,
      userId: "owner",
      kind: isUser ? "turn" : "resume",
      message: isUser ? "Add a footer" : null,
      target: { kind: "api", model: "fixture/free", billsToUser: false },
    });
    expect((await queue.claim("new-worker"))?.id).toBe(NEXT);
    const current = {
      ...original,
      turnId: isUser ? NEXT : CHILD,
      createdAt: new Date(now + 1000).toISOString(),
    };
    await events.append({
      ...current,
      type: "user.message",
      payload: isUser
        ? { text: "Add a footer" }
        : { text: "Repair after reopen", repair: { requestId: NEXT, jobId: JOB } },
    });
    if (isUser)
      await events.append({
        ...current,
        type: "job.started",
        payload: { jobId: NEXT_JOB, objective: "Add a footer" },
      });
    await events.append({
      ...current,
      type: "turn.started",
      payload: { source: isUser ? "user" : "verification" },
    });
    if (scenario !== "later-resume-active") {
      const cancelled = scenario === "later-resume-cancelled";
      await events.append(
        cancelled
          ? {
              ...current,
              type: "turn.failed",
              payload: { reason: "cancelled", message: "stopped" },
            }
          : { ...current, type: "turn.completed", payload: { ...completed, commitSha: null } },
      );
      await events.append({
        ...current,
        type: "job.completed",
        payload: {
          jobId: isUser ? NEXT_JOB : JOB,
          outcome: cancelled ? "abandoned" : "unverified",
        },
      });
      expect(await queue.settle(NEXT, "new-worker", cancelled ? "failed" : "done")).toBe(true);
    }
  }

  const before = await events.readFrom(SESSION, 0);
  expect(
    await sweepOrphanedRequests({ queue, events, bus, now: () => new Date(now).toISOString() }),
  ).toEqual({ orphaned: [], announced: [], failed: [] });
  expect(await events.readFrom(SESSION, 0)).toEqual(before);
  expect(await queue.unannouncedOrphans()).toEqual([]);
  const active = scenario === "later-resume-active";
  expect(await queue.isBusy([SESSION])).toBe(active);
  const app = api(queue, events);
  const hook = renderHook(() =>
    useTurnSubmission({
      sessionId: SESSION,
      events: before,
      fetchJson: async (input, init) => app.request(input, init),
    }),
  );
  await refresh();
  try {
    expect(hook.result.current.pending).toBeUndefined();
    if (!active) {
      await act(async () => {
        await hook.result.current.cancel();
      });
      expect(await queue.requestCancel(SESSION)).toEqual({ cancelled: false });
      expect(await queue.claim("after-reload")).toBeNull();
    }
    expect({
      running: hook.result.current.running,
      startedAt: hook.result.current.startedAt,
    }).toEqual({
      running: active,
      startedAt: active ? new Date(now + 1000).toISOString() : undefined,
    });
  } finally {
    hook.unmount();
  }
});

function gate<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function staleHistory() {
  const events = new InMemoryEventStore();
  await events.append({
    sessionId: SESSION,
    turnId: REPAIR,
    createdAt: "2026-10-19T00:00:01.000Z",
    type: "user.message",
    payload: { text: "Legacy repair" },
  });
  await events.append({
    sessionId: SESSION,
    turnId: REPAIR,
    createdAt: "2026-10-19T00:00:01.000Z",
    type: "turn.started",
    payload: { source: "verification" },
  });
  return events;
}

const newerWorkCases = (["user", "manual", "resume", "legacy-resume"] as const).flatMap((kind) =>
  (["completed", "cancelled"] as const).map((outcome) => ({ kind, outcome })),
);
it.each(newerWorkCases)(
  "reconciles newer other-client $kind through queue, preparation, start and $outcome",
  async ({ kind, outcome }) => {
    vi.useFakeTimers();
    const events = await staleHistory();
    const queue = new InMemoryTurnQueue();
    const app = api(queue, events);
    const hook = renderHook(
      (log: StoredEvent[]) =>
        useTurnSubmission({
          sessionId: SESSION,
          events: log,
          fetchJson: async (input, init) => app.request(input, init),
        }),
      { initialProps: await events.readFrom(SESSION, 0) },
    );
    await refresh();
    expect(hook.result.current.running).toBe(false);
    await queue.enqueue({
      id: NEXT,
      sessionId: SESSION,
      userId: FAKE_OWNER,
      kind: kind.includes("resume") ? "resume" : "turn",
      message: kind.includes("resume") ? null : kind === "manual" ? "/compact" : "New work",
      target: { kind: "api", model: "fixture/free", billsToUser: false },
    });
    await refresh();
    expect(hook.result.current.running).toBe(true);
    expect(hook.result.current.startedAt).toBeUndefined();
    expect((await queue.claim("new-worker"))?.id).toBe(NEXT);
    await refresh();
    expect(hook.result.current.running).toBe(true);
    expect(hook.result.current.startedAt).toBeUndefined();
    const current = {
      sessionId: SESSION,
      turnId: kind.includes("resume") ? CHILD : NEXT,
      createdAt: "2026-10-19T00:02:00.000Z",
    };
    await events.append(
      kind === "manual"
        ? { ...current, type: "compaction.started", payload: { id: NEXT, trigger: "manual" } }
        : {
            ...current,
            type: "user.message",
            payload: {
              text: "New work",
              ...(kind === "resume" ? { repair: { requestId: NEXT, jobId: JOB } } : {}),
            },
          },
    );
    hook.rerender(await events.readFrom(SESSION, 0));
    expect(hook.result.current.running).toBe(true);
    expect(hook.result.current.startedAt).toBe(kind === "manual" ? current.createdAt : undefined);
    await events.append({
      ...current,
      type: "turn.started",
      payload: { source: kind.includes("resume") ? "verification" : "user" },
    });
    hook.rerender(await events.readFrom(SESSION, 0));
    expect(hook.result.current.startedAt).toBe(current.createdAt);
    if (outcome === "cancelled") await queue.requestCancel(SESSION);
    await events.append(
      outcome === "cancelled"
        ? { ...current, type: "turn.failed", payload: { reason: "cancelled", message: "Stopped" } }
        : { ...current, type: "turn.completed", payload: completed },
    );
    await queue.settle(NEXT, "new-worker", outcome === "cancelled" ? "failed" : "done");
    hook.rerender(await events.readFrom(SESSION, 0));
    await refresh();
    expect(hook.result.current.running).toBe(false);
    expect(hook.result.current.startedAt).toBeUndefined();
    hook.unmount();
  },
);

it("rejects delayed idle across local admission, without clearing the accepted pending request", async () => {
  vi.useFakeTimers();
  const events = await staleHistory();
  const queue = new InMemoryTurnQueue();
  const app = api(queue, events);
  const release = gate<void>();
  const received = gate<void>();
  const hook = renderHook(
    (log: StoredEvent[]) =>
      useTurnSubmission({
        sessionId: SESSION,
        events: log,
        fetchJson: async (input, init) => {
          if (!input.includes("/activity")) return app.request(input, init);
          const response = await app.request(input, init);
          received.resolve();
          await release.promise;
          return response;
        },
      }),
    { initialProps: await events.readFrom(SESSION, 0) },
  );
  await refresh();
  await received.promise;
  await act(async () => {
    await hook.result.current.submit("New work");
  });
  await act(async () => {
    release.resolve();
  });
  expect(hook.result.current.running).toBe(true);
  expect(hook.result.current.pending).toBe("New work");
  hook.unmount();
});

it("does not apply an old idle response to newer observed work beyond its covered cursor", async () => {
  vi.useFakeTimers();
  const events = await staleHistory();
  const queue = new InMemoryTurnQueue();
  const app = api(queue, events);
  const release = gate<void>();
  const hook = renderHook(
    (log: StoredEvent[]) =>
      useTurnSubmission({
        sessionId: SESSION,
        events: log,
        fetchJson: async (input, init) => {
          const response = await app.request(input, init);
          await release.promise;
          return response;
        },
      }),
    { initialProps: await events.readFrom(SESSION, 0) },
  );
  await refresh();
  await queue.enqueue({
    id: NEXT,
    sessionId: SESSION,
    userId: FAKE_OWNER,
    kind: "resume",
    message: null,
    target: { kind: "api", model: "fixture/free", billsToUser: false },
  });
  await queue.claim("new-worker");
  const current = { sessionId: SESSION, turnId: CHILD, createdAt: "2026-10-19T00:02:00.000Z" };
  await events.append({
    ...current,
    type: "user.message",
    payload: { text: "Repair", repair: { requestId: NEXT, jobId: JOB } },
  });
  await events.append({ ...current, type: "turn.started", payload: { source: "verification" } });
  hook.rerender(await events.readFrom(SESSION, 0));
  await act(async () => {
    release.resolve();
  });
  expect(hook.result.current.running).toBe(true);
  expect(hook.result.current.startedAt).toBe(current.createdAt);
  hook.unmount();
});

it.each(["network", "malformed", "wrong-session", "http"] as const)(
  "treats %s activity failure as unknown",
  async (failure) => {
    vi.useFakeTimers();
    const events = await staleHistory();
    const app = api(new InMemoryTurnQueue(), events);
    const log = await events.readFrom(SESSION, 0);
    const hook = renderHook(() =>
      useTurnSubmission({
        sessionId: SESSION,
        events: log,
        fetchJson: async (input, init) => {
          if (failure === "network") throw new Error("offline");
          const reply = SessionActivitySchema.parse(await (await app.request(input, init)).json());
          return Response.json(
            failure === "wrong-session"
              ? { ...reply, sessionId: NEXT }
              : failure === "malformed"
                ? { ...reply, active: "false" }
                : reply,
            { status: failure === "http" ? 503 : 200 },
          );
        },
      }),
    );
    await refresh();
    expect(hook.result.current.running).toBe(true);
    expect(hook.result.current.startedAt).toBe(log[1]?.createdAt);
    hook.unmount();
  },
);

it("ignores a response from a previous session and aborts outstanding reads on unmount", async () => {
  vi.useFakeTimers();
  const events = await staleHistory();
  const app = api(new InMemoryTurnQueue(), events);
  const release = gate<void>();
  const signals: (AbortSignal | null | undefined)[] = [];
  const hook = renderHook(
    (sessionId: string) =>
      useTurnSubmission({
        sessionId,
        events: [
          {
            sessionId,
            turnId: REPAIR,
            seq: 1,
            createdAt: "2026-10-19T00:00:01.000Z",
            type: "turn.started",
            payload: { source: "verification" },
          },
        ],
        fetchJson: async (input, init) => {
          signals.push(init?.signal);
          const response = await app.request(input, init);
          await release.promise;
          return response;
        },
      }),
    { initialProps: SESSION },
  );
  await refresh();
  hook.rerender(NEXT);
  await act(async () => {
    release.resolve();
  });
  expect(signals[0]?.aborted).toBe(true);
  expect(hook.result.current.running).toBe(true);
  expect(hook.result.current.startedAt).toBe("2026-10-19T00:00:01.000Z");
  hook.unmount();
});

it("keeps an active unannotated legacy repair visible on fresh mount", async () => {
  vi.useFakeTimers();
  const store = await staleHistory();
  const queue = new InMemoryTurnQueue();
  await queue.enqueue({
    id: REQUEST,
    sessionId: SESSION,
    userId: FAKE_OWNER,
    kind: "resume",
    message: null,
    target: { kind: "api", model: "fixture/free", billsToUser: false },
  });
  await queue.claim("legacy-worker");
  const app = api(queue, store);
  const log = await store.readFrom(SESSION, 0);
  const hook = renderHook(() =>
    useTurnSubmission({
      sessionId: SESSION,
      events: log,
      fetchJson: async (input, init) => app.request(input, init),
    }),
  );
  await refresh();
  expect(hook.result.current.running).toBe(true);
  expect(hook.result.current.startedAt).toBe(log[1]?.createdAt);
  hook.unmount();
});

it("refreshes eventless queue activity on reconnect and discards the interrupted read", async () => {
  vi.useFakeTimers();
  const queue = new InMemoryTurnQueue();
  const store = new InMemoryEventStore();
  const app = api(queue, store);
  const release = gate<void>();
  const signals: (AbortSignal | null | undefined)[] = [];
  let holdIdle = false;
  const hook = renderHook(
    (connectionStatus: "open" | "reconnecting") =>
      useTurnSubmission({
        sessionId: SESSION,
        events: [],
        connectionStatus,
        replayed: true,
        fetchJson: async (input, init) => {
          const response = await app.request(input, init);
          if (holdIdle) {
            holdIdle = false;
            signals.push(init?.signal);
            await release.promise;
          }
          return response;
        },
      }),
    { initialProps: "open" },
  );
  await refresh();
  expect(hook.result.current.running).toBe(false);
  holdIdle = true;
  await refresh();
  expect(signals).toHaveLength(1);
  expect(signals[0]?.aborted).toBe(false);
  hook.rerender("reconnecting");
  expect(signals[0]?.aborted).toBe(true);
  await queue.enqueue({
    id: REQUEST,
    sessionId: SESSION,
    userId: FAKE_OWNER,
    kind: "resume",
    message: null,
    target: { kind: "api", model: "fixture/free", billsToUser: false },
  });
  hook.rerender("open");
  await refresh();
  expect(hook.result.current.running).toBe(true);
  expect(hook.result.current.startedAt).toBeUndefined();
  await act(async () => release.resolve());
  expect(hook.result.current.running).toBe(true);
  await queue.requestCancel(SESSION);
  await refresh();
  expect(hook.result.current.running).toBe(false);
  hook.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
