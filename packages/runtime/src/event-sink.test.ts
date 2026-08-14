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

/** A store and a bus that write their calls into one shared list. */
function recording(options: { failAppendAt?: number } = {}) {
  const calls: string[] = [];
  const store = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  let appends = 0;

  const recordingStore: EventStore = {
    append: async (event) => {
      appends += 1;
      if (appends === options.failAppendAt) {
        calls.push(`append-failed:${event.type}`);
        throw new Error("the store is down");
      }
      const stored = await store.append(event);
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

  return { calls, store, sink: new EventSink(recordingStore, recordingBus) };
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
