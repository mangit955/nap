import { NapEventSchema } from "@nap/shared/events";
import { LEASE_GRACE_MS, LEASE_TTL_MS } from "@nap/shared/lease-windows";
import type { EventStore, PendingEvent } from "@nap/shared/ports/event-store";
import { expect, it, vi } from "vitest";
import { buildTranscript } from "../apps/web/src/chat/transcript.ts";
import { inFlightTurn, turnStartedAt } from "../apps/web/src/chat/working-state.ts";
import { InMemoryEventBus } from "../packages/db/src/testing/in-memory-event-bus.ts";
import { InMemoryEventStore } from "../packages/db/src/testing/in-memory-event-store.ts";
import { InMemoryTurnQueue } from "../packages/db/src/testing/in-memory-turn-queue.ts";
import { sweepOrphanedRequests } from "../packages/runtime/src/janitor.ts";

const SESSION = "00000000-0000-4000-8000-000000000001";
const OLD = "00000000-0000-4000-8000-000000000002";
const REQUEST = "00000000-0000-4000-8000-000000000003";
const COMPACTION = "00000000-0000-4000-8000-000000000004";
const LATER = "00000000-0000-4000-8000-000000000005";
const OLD_TEXT = "Build the dashboard";
const attachments = [
  {
    kind: "image" as const,
    name: "old.jpg",
    frames: [{ timestamp: 0, mediaType: "image/jpeg" as const, data: "AAAA" }],
  },
];

async function fixture(markerDurable = false, message = "/compact") {
  let now = Date.parse("2026-10-19T00:00:00.000Z");
  const queue = new InMemoryTurnQueue({ now: () => now });
  const events = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const envelope = { sessionId: SESSION, turnId: OLD, createdAt: new Date(now).toISOString() };
  await events.append({
    ...envelope,
    type: "user.message",
    payload: { text: OLD_TEXT, attachments },
  });
  await events.append({ ...envelope, type: "agent.message", payload: { text: "Done" } });
  await events.append({
    ...envelope,
    type: "turn.completed",
    payload: { usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1, commitSha: null },
  });
  await queue.enqueue({
    id: REQUEST,
    sessionId: SESSION,
    userId: "owner",
    kind: "turn",
    message,
    model: "fixture/free",
    billsToUser: false,
  });
  expect((await queue.claim("worker-that-exits"))?.id).toBe(REQUEST);
  if (markerDurable) {
    await events.append({
      ...envelope,
      turnId: REQUEST,
      type: "compaction.started",
      payload: { id: COMPACTION, trigger: "manual" },
    });
  }
  now += LEASE_TTL_MS + LEASE_GRACE_MS + 1;
  const sweep = (store: EventStore = events) =>
    sweepOrphanedRequests({
      queue,
      events: store,
      bus,
      now: () => new Date(now).toISOString(),
    });
  const history = () => events.readFrom(SESSION, 0);
  return { queue, events, bus, envelope, sweep, history };
}

async function expectRecovered(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await f.queue.getStatus({ id: REQUEST, sessionId: SESSION, userId: "owner" })).toEqual({
    id: REQUEST,
    state: "orphaned",
  });
  expect(await f.queue.claim("next-worker")).toBeNull();
  const history = await f.history();
  const recovered = history.filter((event) => event.turnId === REQUEST);
  for (const event of recovered) expect(NapEventSchema.safeParse(event).success).toBe(true);
  expect(recovered.map((event) => event.type)).toEqual([
    "compaction.started",
    "compaction.failed",
    "turn.failed",
    "system.notice",
  ]);
  // Neither recovery nor a repeated tick starts a job, writes a prompt or records a commit.
  expect(history.filter((event) => event.type === "user.message")).toHaveLength(1);
  expect(history.some((event) => event.type.startsWith("job."))).toBe(false);
  const transcript = buildTranscript(history);
  expect(transcript.filter((item) => item.kind === "compaction")).toEqual([
    expect.objectContaining({ turnId: REQUEST, status: "failed" }),
  ]);
  const failure = transcript.findLast((item) => item.kind === "turn-end");
  expect(failure).toMatchObject({
    outcome: "failed",
    reason: "internal",
    retryMessage: "/compact",
  });
  expect(failure).not.toHaveProperty("retryAttachments");
  return recovered;
}

it.each([false, true])(
  "recovers an orphaned /compact, marker durable=%s",
  async (markerDurable) => {
    const f = await fixture(markerDurable);
    const before = await f.history();
    expect((await f.sweep()).announced).toEqual([REQUEST]);
    const recovered = await expectRecovered(f);
    const start = recovered[0];
    expect(start).toMatchObject({
      payload: { id: markerDurable ? COMPACTION : REQUEST, trigger: "manual" },
    });
    expect((await f.history()).slice(0, before.length)).toEqual(before);
    expect(await f.sweep()).toEqual({ orphaned: [], announced: [], failed: [] });
    expect(await f.sweep()).toEqual({ orphaned: [], announced: [], failed: [] });
    await expectRecovered(f);
  },
);

const interruptions = [
  "compaction.started",
  "compaction.failed",
  "turn.failed",
  "system.notice",
] as const;
it.each(interruptions.flatMap((type) => [false, true].map((committed) => ({ type, committed }))))(
  "finishes interrupted closeout at $type, append committed=$committed",
  async ({ type, committed }) => {
    const f = await fixture();
    const interrupted: EventStore = {
      readFrom: (sessionId, seq) => f.events.readFrom(sessionId, seq),
      append: async (event, options) => {
        if (event.type !== type) return f.events.append(event, options);
        if (committed) await f.events.append(event, options);
        throw new Error("closeout interrupted");
      },
    };
    expect((await f.sweep(interrupted)).failed).toEqual([
      { requestId: REQUEST, message: "closeout interrupted" },
    ]);
    expect(await f.queue.unannouncedOrphans()).toHaveLength(1);
    expect((await f.sweep()).announced).toEqual([REQUEST]);
    await expectRecovered(f);
  },
);

it("does not repeat a durable closeout when marking the orphan announced fails", async () => {
  const f = await fixture();
  const mark = vi
    .spyOn(f.queue, "markOrphanAnnounced")
    .mockRejectedValueOnce(new Error("mark lost"));
  expect((await f.sweep()).failed).toEqual([{ requestId: REQUEST, message: "mark lost" }]);
  const before = await f.history();
  expect((await f.sweep()).announced).toEqual([REQUEST]);
  expect(await f.history()).toEqual(before);
  expect(mark).toHaveBeenCalledTimes(2);
  await expectRecovered(f);
});

it("keeps the original command retry when later ordinary work precedes orphan announcement", async () => {
  const f = await fixture();
  // The orphan row releases the lease before the announcement. A later request can now run.
  await f.queue.orphanExpired();
  await f.queue.enqueue({
    id: LATER,
    sessionId: SESSION,
    userId: "owner",
    kind: "turn",
    message: "Add a footer",
    attachments,
    model: "fixture/free",
    billsToUser: false,
  });
  expect((await f.queue.claim("later-worker"))?.id).toBe(LATER);
  await f.events.append({
    ...f.envelope,
    turnId: LATER,
    type: "user.message",
    payload: { text: "Add a footer", attachments },
  });
  await f.sweep();
  await f.events.append({
    ...f.envelope,
    turnId: LATER,
    type: "turn.failed",
    payload: { reason: "internal", message: "later failure" },
  });
  const failures = buildTranscript(await f.history()).filter(
    (item) => item.kind === "turn-end" && item.outcome === "failed",
  );
  expect(failures).toEqual([
    expect.objectContaining({ retryMessage: "/compact" }),
    expect.objectContaining({ retryMessage: "Add a footer", retryAttachments: attachments }),
  ]);
  expect(failures[0]).not.toHaveProperty("retryAttachments");
  expect(await f.queue.getStatus({ id: LATER, sessionId: SESSION, userId: "owner" })).toEqual({
    id: LATER,
    state: "leased",
  });
});

it("leaves a command with a durable success completed when its worker missed settlement", async () => {
  const f = await fixture(true);
  const completed: PendingEvent[] = [
    {
      ...f.envelope,
      turnId: REQUEST,
      type: "compaction.completed",
      payload: {
        id: COMPACTION,
        result: { kind: "api", checkpoint: { summary: "saved", coveredThrough: 3, tail: [] } },
        usage: { inputTokens: 1, outputTokens: 1 },
        beforeTokens: 100,
        afterTokens: 10,
      },
    },
    {
      ...f.envelope,
      turnId: REQUEST,
      type: "turn.completed",
      payload: {
        usage: { inputTokens: 1, outputTokens: 1 },
        durationMs: 1,
        commitSha: null,
      },
    },
  ];
  for (const event of completed) await f.events.append(event);
  expect((await f.sweep()).announced).toEqual([REQUEST]);
  const history = await f.history();
  expect(
    history.some((event) => event.type === "compaction.failed" || event.type === "turn.failed"),
  ).toBe(false);
  expect(buildTranscript(history).filter((item) => item.kind === "compaction")).toEqual([
    expect.objectContaining({ status: "completed" }),
  ]);
});

it("keeps an orphan owed if its durable marker cannot be read", async () => {
  const f = await fixture(true);
  const append = vi.fn(f.events.append.bind(f.events));
  const failed = await f.sweep({
    append,
    readFrom: async () => {
      throw new Error("read lost");
    },
  });
  expect(failed.failed).toEqual([{ requestId: REQUEST, message: "read lost" }]);
  expect(append).not.toHaveBeenCalled();
  expect((await f.sweep()).announced).toEqual([REQUEST]);
  await expectRecovered(f);
});

it.each(["/compact more", "ordinary request"])(
  "does not infer a manual command from %s",
  async (message) => {
    const f = await fixture(false, message);
    await f.sweep();
    const transcript = buildTranscript(await f.history());
    expect(transcript.some((item) => item.kind === "compaction")).toBe(false);
    expect(transcript.at(-2)).toMatchObject({ kind: "turn-end", retryMessage: undefined });
  },
);

it("uses one manual card when overlapping janitors read the same missing marker", async () => {
  const f = await fixture();
  await f.queue.orphanExpired();
  const readers: (() => void)[] = [];
  const concurrent: EventStore = {
    append: (event, options) => f.events.append(event, options),
    readFrom: async (sessionId, seq) => {
      const snapshot = await f.events.readFrom(sessionId, seq);
      await new Promise<void>((resolve) => {
        readers.push(resolve);
        if (readers.length === 2) for (const done of readers) done();
      });
      return snapshot;
    },
  };
  const sweeps = await Promise.all([f.sweep(concurrent), f.sweep(concurrent)]);
  expect(sweeps.every((result) => result.failed.length === 0)).toBe(true);
  const history = await f.history();
  const starts = history.filter((event) => event.type === "compaction.started");
  expect(starts).toHaveLength(2);
  expect(starts.every((event) => event.payload.id === REQUEST)).toBe(true);
  const transcript = buildTranscript(history);
  const cards = transcript.filter((item) => item.kind === "compaction");
  expect(cards).toEqual([
    expect.objectContaining({ id: REQUEST, status: "failed", key: starts[0]?.seq }),
  ]);
  for (const failure of transcript.filter(
    (item) => item.kind === "turn-end" && item.outcome === "failed",
  )) {
    expect(failure).toMatchObject({ retryMessage: "/compact" });
    expect(failure).not.toHaveProperty("retryAttachments");
  }
  const durable = await f.history();
  await f.sweep();
  expect(await f.history()).toEqual(durable);
});

it("recognizes the same whitespace-trimmed command as the runtime", async () => {
  const f = await fixture(false, "  /compact\n");
  await f.sweep();
  await expectRecovered(f);
});

function gate() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

it.each([false, true])(
  "keeps recovered manual work idle after a late janitor, interrupted=%s",
  async (interrupted) => {
    const f = await fixture();
    await f.queue.orphanExpired();
    const readTaken = gate();
    const releaseRead = gate();
    const lateStore: EventStore = {
      readFrom: async (sessionId, seq) => {
        const snapshot = await f.events.readFrom(sessionId, seq);
        readTaken.release();
        await releaseRead.ready;
        return snapshot;
      },
      append: async (event, options) => {
        if (interrupted && event.type === "compaction.failed")
          throw new Error("late closeout lost");
        return f.events.append(event, options);
      },
    };
    // B reads before A writes, then appends its duplicate after A has finished announcing.
    const lateSweep = f.sweep(lateStore);
    try {
      await readTaken.ready;
      expect((await f.sweep()).announced).toEqual([REQUEST]);
      expect(await f.queue.unannouncedOrphans()).toEqual([]);
    } finally {
      releaseRead.release();
      await lateSweep;
    }
    expect((await lateSweep).failed).toEqual(
      interrupted ? [{ requestId: REQUEST, message: "late closeout lost" }] : [],
    );

    const history = await f.history();
    expect(history.filter((event) => event.type === "compaction.started")).toHaveLength(2);
    expect(buildTranscript(history).filter((item) => item.kind === "compaction")).toEqual([
      expect.objectContaining({ id: REQUEST, status: "failed" }),
    ]);
    expect(await f.queue.getStatus({ id: REQUEST, sessionId: SESSION, userId: "owner" })).toEqual({
      id: REQUEST,
      state: "orphaned",
    });
    expect(await f.sweep()).toEqual({ orphaned: [], announced: [], failed: [] });
    expect(await f.history()).toEqual(history);
    expect(await f.queue.requestCancel(SESSION)).toEqual({ cancelled: false });
    expect(await f.queue.claim("next-worker")).toBeNull();
    expect(inFlightTurn(history)).toBeUndefined();
    expect(turnStartedAt(history)).toBeUndefined();
  },
);
