import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import type { EventBus } from "@nap/shared/ports/event-bus";
import type { EventStore, PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import { describe, expect, it } from "vitest";
import { EventSink } from "./event-sink.ts";

/**
 * Append, then publish — the rule the whole system reads events under.
 *
 * A subscriber handed an event that was never written is shown history that does not exist: it
 * renders the event, reconnects a moment later, replays from the log, and finds it gone. Every
 * module header in this package cites the rule; until now nothing asserted it, because the sink
 * was only ever exercised through `runTurn`, where an ordering slip looks like a passing test.
 *
 * The order is observable because both fakes record into one list, in the order they were called.
 */

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const TURN_ID = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

/** A turn that ended cleanly and changed nothing. */
const COMPLETED = {
  usage: { inputTokens: 10, outputTokens: 5 },
  durationMs: 1200,
  commitSha: null,
};

function pending(type: PendingEvent["type"], payload: object = {}): PendingEvent {
  return {
    type,
    payload,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    createdAt: "2026-08-09T12:00:00.000Z",
  } as PendingEvent;
}

/**
 * How an append fails on a given attempt.
 *
 * `committed` is the case the whole retry design turns on: the transaction went through and
 * the acknowledgement did not come back, which the caller cannot tell from a clean failure.
 */
type ScriptedFailure = { error: unknown; committed?: boolean };

/** A store and a bus that write their calls into one shared list. */
function recording(
  options: {
    failAppendAt?: number;
    /** Returns how attempt `n` at the append fails, or `undefined` for one that succeeds. */
    appendFailure?: (attempt: number) => ScriptedFailure | undefined;
  } = {},
) {
  const calls: string[] = [];
  const waits: number[] = [];
  const watermarks: (number | undefined)[] = [];
  const store = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  let appends = 0;

  const recordingStore: EventStore = {
    append: async (event, appendOptions) => {
      appends += 1;
      watermarks.push(appendOptions?.retryAfterSeq);

      const scripted = options.appendFailure?.(appends);
      if (appends === options.failAppendAt || scripted !== undefined) {
        if (scripted?.committed === true) await store.append(event, appendOptions);
        calls.push(`append-failed:${event.type}`);
        throw scripted?.error ?? new Error("the store is down");
      }

      const stored = await store.append(event, appendOptions);
      calls.push(`append:${event.type}`);
      return stored;
    },
    readFrom: (sessionId, afterSeq) => store.readFrom(sessionId, afterSeq),
  };

  const recordingBus: EventBus = {
    publish: (event: StoredEvent) => {
      calls.push(`publish:${event.type}`);
      bus.publish(event);
    },
    subscribe: (sessionId, handler) => bus.subscribe(sessionId, handler),
  };

  const sink = new EventSink(recordingStore, recordingBus, {
    sleep: async (ms) => {
      waits.push(ms);
    },
  });

  return { calls, waits, watermarks, store, sink, attempts: () => appends };
}

/** A failure of a class the sink is allowed to try again. */
function transient(): Error {
  return Object.assign(new Error("connection lost"), { code: "CONNECTION_CLOSED" });
}

describe("the order events reach the world in", () => {
  it("appends an event before publishing it", async () => {
    const { calls, sink } = recording();

    sink.emit(pending("user.message", { text: "build me a todo list" }));
    await sink.drain();

    expect(calls).toEqual(["append:user.message", "publish:user.message"]);
  });

  it("appends in the order they were emitted, however fast they arrive", async () => {
    // `emit` cannot be awaited — the agent calls it mid-loop and carries on — so ordering is the
    // sink's problem, not the caller's. Three emissions in one synchronous run is exactly what a
    // streaming turn does.
    const { calls, sink } = recording();

    sink.emit(pending("turn.started"));
    sink.emit(pending("agent.message", { text: "on it" }));
    sink.emit(pending("turn.completed", COMPLETED));
    await sink.drain();

    expect(calls).toEqual([
      "append:turn.started",
      "publish:turn.started",
      "append:agent.message",
      "publish:agent.message",
      "append:turn.completed",
      "publish:turn.completed",
    ]);
  });

  it("assigns sequence numbers in emission order", async () => {
    const { sink, store } = recording();

    sink.emit(pending("turn.started"));
    sink.emit(pending("agent.message", { text: "on it" }));
    await sink.drain();

    const written = await store.readFrom(SESSION_ID, 0);
    expect(written.map((event) => event.type)).toEqual(["turn.started", "agent.message"]);
  });
});

describe("when the store fails", () => {
  it("publishes nothing for the event that could not be written", async () => {
    const { calls, sink } = recording({ failAppendAt: 1 });

    sink.emit(pending("user.message", { text: "build me a todo list" }));

    await expect(sink.drain()).rejects.toThrow("the store is down");
    expect(calls).toEqual(["append-failed:user.message"]);
  });

  it("stops the pipeline rather than carrying on past the hole", async () => {
    // Continuing would publish events whose predecessors were never written, which is the exact
    // history-that-does-not-exist this ordering closes.
    const { calls, sink } = recording({ failAppendAt: 2 });

    sink.emit(pending("turn.started"));
    sink.emit(pending("agent.message", { text: "on it" }));
    sink.emit(pending("turn.completed", COMPLETED));

    await expect(sink.drain()).rejects.toThrow("the store is down");
    expect(calls).toEqual([
      "append:turn.started",
      "publish:turn.started",
      "append-failed:agent.message",
    ]);
  });
});

describe("when the store fails transiently", () => {
  /**
   * At a hundred concurrent turns a dropped pooled connection is routine, and treating each one
   * as fatal throws away a whole turn along with its repair budget. See `docs/scaling-design.md`
   * §17.
   */

  it("tries again and carries on", async () => {
    const { calls, sink, attempts } = recording({
      appendFailure: (attempt) => (attempt === 1 ? { error: transient() } : undefined),
    });

    sink.emit(pending("user.message", { text: "build me a todo list" }));
    await sink.drain();

    expect(attempts()).toBe(2);
    expect(calls).toEqual([
      "append-failed:user.message",
      "append:user.message",
      "publish:user.message",
    ]);
  });

  it("leaves exactly one row when the lost attempt had already committed", async () => {
    // The dangerous case. The transaction went through and the acknowledgement did not come
    // back; a retry that inserted again would put the same message in the chat twice.
    const { sink, store, calls } = recording({
      appendFailure: (attempt) =>
        attempt === 1 ? { error: transient(), committed: true } : undefined,
    });

    sink.emit(pending("agent.message", { text: "on it" }));
    await sink.drain();

    const written = await store.readFrom(SESSION_ID, 0);
    expect(written).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("publish:"))).toEqual(["publish:agent.message"]);
  });

  it("does not mistake the identical event before it for its own lost append", async () => {
    // A turn can emit the same event twice running — two `command.output` chunks carrying the
    // same text, in the same millisecond. If the second one's attempt fails *before* it
    // commits, a retry that recognises its own row by content alone matches the *first* event,
    // drops the second, and publishes the first one's seq twice.
    const { sink, store, calls } = recording({
      appendFailure: (attempt) => (attempt === 2 ? { error: transient() } : undefined),
    });

    const chunk = pending("command.output", {
      toolCallId: "call_1",
      stream: "stdout",
      chunk: "building...\n",
    });
    sink.emit(chunk);
    sink.emit(chunk);
    await sink.drain();

    const written = await store.readFrom(SESSION_ID, 0);
    expect(written.map((event) => event.seq)).toEqual([1, 2]);
    expect(calls.filter((call) => call.startsWith("publish:"))).toHaveLength(2);
  });

  it("gives the store its watermark on a retry, and nothing on a first attempt", async () => {
    // The store cannot see for itself that an earlier attempt may have committed, and it is the
    // only place that can settle the question under the lock it appends with. What it needs is
    // the seq the sink last saw land: everything at or below that was durable before the
    // attempt began, so only what came after it can be the attempt's own row.
    const { sink, watermarks } = recording({
      appendFailure: (attempt) => (attempt === 2 ? { error: transient() } : undefined),
    });

    sink.emit(pending("turn.started"));
    sink.emit(pending("agent.message", { text: "on it" }));
    await sink.drain();

    // First event: a clean first attempt, no watermark. Second event: its first attempt carries
    // none either, and its retry carries seq 1 — what the first event landed at.
    expect(watermarks).toEqual([undefined, undefined, 1]);
  });

  it("waits the backoff schedule between attempts", async () => {
    const { sink, waits } = recording({
      appendFailure: (attempt) => (attempt <= 2 ? { error: transient() } : undefined),
    });

    sink.emit(pending("turn.started"));
    await sink.drain();

    // 100 and 400, each jittered by up to a quarter either way.
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(75);
    expect(waits[0]).toBeLessThanOrEqual(125);
    expect(waits[1]).toBeGreaterThanOrEqual(300);
    expect(waits[1]).toBeLessThanOrEqual(500);
  });

  it("gives up after three attempts and fails as it always did", async () => {
    const { sink, calls, attempts } = recording({ appendFailure: () => ({ error: transient() }) });

    sink.emit(pending("turn.started"));
    sink.emit(pending("agent.message", { text: "on it" }));

    await expect(sink.drain()).rejects.toThrow("connection lost");
    expect(attempts()).toBe(3);
    // Sticky: the second event is never attempted, and nothing was published.
    expect(calls).toEqual([
      "append-failed:turn.started",
      "append-failed:turn.started",
      "append-failed:turn.started",
    ]);
  });

  it("keeps the ordering rule while retrying", async () => {
    // A retry must not let the event behind it overtake the one being retried.
    const { sink, calls } = recording({
      appendFailure: (attempt) => (attempt === 2 ? { error: transient() } : undefined),
    });

    sink.emit(pending("turn.started"));
    sink.emit(pending("agent.message", { text: "on it" }));
    sink.emit(pending("turn.completed", COMPLETED));
    await sink.drain();

    expect(calls).toEqual([
      "append:turn.started",
      "publish:turn.started",
      "append-failed:agent.message",
      "append:agent.message",
      "publish:agent.message",
      "append:turn.completed",
      "publish:turn.completed",
    ]);
  });
});

describe("when the store fails in a way retrying cannot help", () => {
  it.each([
    ["a unique violation", "23505"],
    ["a foreign key violation", "23503"],
  ])("does not retry %s", async (_name, code) => {
    // A duplicate `(session_id, seq)` means the ordering guarantee itself broke. Retrying would
    // either write the event twice or bury that.
    const error = Object.assign(new Error("duplicate key value"), { code });
    const { sink, attempts } = recording({ appendFailure: () => ({ error }) });

    sink.emit(pending("turn.started"));

    await expect(sink.drain()).rejects.toThrow("duplicate key value");
    expect(attempts()).toBe(1);
  });

  it("does not retry a parse failure", async () => {
    const error = Object.assign(new Error("invalid payload"), { name: "ZodError" });
    const { sink, attempts, waits } = recording({ appendFailure: () => ({ error }) });

    sink.emit(pending("turn.started"));

    await expect(sink.drain()).rejects.toThrow("invalid payload");
    expect(attempts()).toBe(1);
    expect(waits).toEqual([]);
  });
});

describe("what the sink knows about the turn", () => {
  it("has no terminal until the turn ends", async () => {
    const { sink } = recording();

    sink.emit(pending("turn.started"));
    await sink.drain();

    expect(sink.terminal).toBeNull();
  });

  it("remembers how a turn completed, as it was stored", async () => {
    // The runtime reads the sha back off this rather than off what it emitted: the stored event
    // is the one that exists, and it carries the `seq` everything downstream orders by.
    const { sink } = recording();

    sink.emit(pending("turn.completed", { ...COMPLETED, commitSha: "9e107d9d" }));
    await sink.drain();

    expect(sink.terminal).toMatchObject({ type: "turn.completed", seq: expect.any(Number) });
  });

  it("remembers a failure the same way", async () => {
    const { sink } = recording();

    sink.emit(pending("turn.failed", { reason: "internal", message: "no capacity" }));
    await sink.drain();

    expect(sink.terminal).toMatchObject({ type: "turn.failed" });
  });

  it("reports no terminal for an event that was never written", async () => {
    // Otherwise a turn that failed to record its own ending would look, to the runtime, like one
    // that ended cleanly — and the runtime would skip the `turn.failed` it synthesizes for
    // exactly this case.
    const { sink } = recording({ failAppendAt: 1 });

    sink.emit(pending("turn.completed", COMPLETED));

    await expect(sink.drain()).rejects.toThrow();
    expect(sink.terminal).toBeNull();
  });
});

describe("draining", () => {
  it("resolves only once everything emitted is durable", async () => {
    // What the runtime waits on before it decides the turn's outcome. If this resolved early, a
    // turn would report success while its events were still in flight.
    const { calls, sink } = recording();

    sink.emit(pending("turn.started"));
    const drained = sink.drain();
    expect(calls).toEqual([]);

    await drained;
    expect(calls).toEqual(["append:turn.started", "publish:turn.started"]);
  });

  it("stays failed once it has failed", async () => {
    const { sink } = recording({ failAppendAt: 1 });

    sink.emit(pending("turn.started"));
    await expect(sink.drain()).rejects.toThrow();
    await expect(sink.drain()).rejects.toThrow();
  });
});

/**
 * An event the sink is told about before anyone knows what it will say — a new sandbox's
 * `preview.ready`, which waits on a dev server that may take seconds.
 *
 * The turn must not wait for it, so it lands wherever it lands among the streaming events. What
 * it may never do is land after the ending of the turn it belongs to, or after whoever owns the
 * sink has stopped writing — the lease is gone by then.
 */
describe("an event promised before it is known", () => {
  function gate() {
    let open: (event: PendingEvent | null) => void = () => {};
    const promise = new Promise<PendingEvent | null>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  const PREVIEW = pending("preview.ready", { url: "https://5173-x.sandbox.invalid", port: 5173 });

  async function appended(store: InMemoryEventStore): Promise<string[]> {
    return (await store.readFrom(SESSION_ID, 0)).map((event) => event.type);
  }

  /** Long enough for every queued microtask and the in-memory store to have run. */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

  it("lands as soon as it is known, among whatever is streaming", async () => {
    const { store, sink } = recording();
    const preview = gate();

    sink.eventually(preview.promise);
    sink.emit(pending("turn.started"));
    sink.emit(pending("agent.message", { text: "writing the app" }));
    await sink.drain();
    preview.open(PREVIEW);
    await sink.settle();
    sink.emit(pending("agent.message", { text: "still writing" }));
    await sink.drain();

    expect(await appended(store)).toEqual([
      "turn.started",
      "agent.message",
      "preview.ready",
      "agent.message",
    ]);
  });

  it("holds a turn's ending, and everything after it, until it is known", async () => {
    const { store, sink } = recording();
    const preview = gate();

    sink.eventually(preview.promise);
    sink.emit(pending("turn.started"));
    sink.emit(pending("turn.completed", COMPLETED));
    sink.emit(pending("job.completed", { jobId: TURN_ID, outcome: "unverified" }));
    await settled();

    expect(await appended(store)).toEqual(["turn.started"]);

    preview.open(PREVIEW);
    await sink.drain();

    expect(await appended(store)).toEqual([
      "turn.started",
      "preview.ready",
      "turn.completed",
      "job.completed",
    ]);
    expect(sink.terminal?.type).toBe("turn.completed");
  });

  it("holds a job's ending even when no turn ended", async () => {
    // Resuming a project closes a job without running a turn.
    const { store, sink } = recording();
    const preview = gate();

    sink.eventually(preview.promise);
    sink.emit(pending("job.completed", { jobId: TURN_ID, outcome: "unverified" }));
    preview.open(PREVIEW);
    await sink.drain();

    expect(await appended(store)).toEqual(["preview.ready", "job.completed"]);
  });

  it("does not make drain wait while nothing is held", async () => {
    // Drain is called all through a turn. Waiting there would be the wait this exists to remove.
    const { store, sink } = recording();
    const never = gate();

    sink.eventually(never.promise);
    sink.emit(pending("agent.message", { text: "on it" }));
    const drained = await Promise.race([
      sink.drain().then(() => true),
      settled().then(() => false),
    ]);

    expect(drained).toBe(true);
    expect(await appended(store)).toEqual(["agent.message"]);
  });

  it("makes drain wait once an ending is held behind it", async () => {
    const { store, sink } = recording();
    const preview = gate();

    sink.eventually(preview.promise);
    sink.emit(pending("turn.completed", COMPLETED));
    let drained = false;
    const draining = sink.drain().then(() => {
      drained = true;
    });
    await settled();
    expect(drained).toBe(false);

    // Known to be nothing — a dev server that never answered.
    preview.open(null);
    await draining;

    expect(await appended(store)).toEqual(["turn.completed"]);
  });

  it("makes settle wait for it, and nothing after settle can be written by it", async () => {
    const { store, sink } = recording();
    const preview = gate();

    sink.eventually(preview.promise);
    let done = false;
    const settling = sink.settle().then(() => {
      done = true;
    });
    await settled();
    expect(done).toBe(false);

    preview.open(PREVIEW);
    await settling;
    expect(await appended(store)).toEqual(["preview.ready"]);
  });

  it("treats a promise that rejects as nothing to write, and lets the ending through", async () => {
    const { store, sink } = recording();

    sink.eventually(Promise.reject(new Error("the probe blew up")));
    sink.emit(pending("turn.completed", COMPLETED));
    await sink.settle();

    expect(await appended(store)).toEqual(["turn.completed"]);
  });
});
