import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import type { EventStore, PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionHistory } from "./session-history.ts";

const SESSION = "6b1f0c3e-2d4a-4e5b-8c6d-7e8f9a0b1c2d";
const TURN = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

function message(text: string): PendingEvent {
  return {
    type: "agent.message",
    sessionId: SESSION,
    turnId: TURN,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { text },
  };
}

/** Every `readFrom` the history makes, as the `afterSeq` it asked from. */
function counting(store: EventStore): { store: EventStore; reads: number[] } {
  const reads: number[] = [];
  return {
    reads,
    store: {
      append: (event, options) => store.append(event, options),
      readFrom: (sessionId, afterSeq) => {
        reads.push(afterSeq);
        return store.readFrom(sessionId, afterSeq);
      },
    },
  };
}

let inner: InMemoryEventStore;

beforeEach(() => {
  inner = new InMemoryEventStore();
});

describe("SessionHistory", () => {
  it("reads the whole log once and only what was appended after that", async () => {
    const { store, reads } = counting(inner);
    await inner.append(message("one"));
    await inner.append(message("two"));
    const history = new SessionHistory(store, SESSION);

    const first = await history.read();
    await inner.append(message("three"));
    const second = await history.read();
    const third = await history.read();

    expect(reads).toEqual([0, 2, 3]);
    expect(first.map((event) => event.seq)).toEqual([1, 2]);
    expect(second).toStrictEqual(await inner.readFrom(SESSION, 0));
    expect(third).toStrictEqual(second);
  });

  it("hands out snapshots that a later read does not change", async () => {
    // A turn's history is "the log before its prompt was logged", and the context engine is
    // handed it after the prompt is appended. A shared array would grow the prompt into it.
    const history = new SessionHistory(inner, SESSION);
    await inner.append(message("before"));
    const before = await history.read();

    await inner.append(message("the prompt"));
    await history.read();

    expect(before.map((event) => event.seq)).toEqual([1]);
  });

  it("keeps each event once when two reads overlap", async () => {
    await inner.append(message("one"));
    const history = new SessionHistory(inner, SESSION);

    const [a, b] = await Promise.all([history.read(), history.read()]);
    await inner.append(message("two"));
    const after = await history.read();

    expect(a.map((event) => event.seq)).toEqual([1]);
    expect(b.map((event) => event.seq)).toEqual([1]);
    expect(after.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("is an empty log for a session with nothing in it", async () => {
    const history = new SessionHistory(inner, SESSION);
    const empty: StoredEvent[] = await history.read();
    expect(empty).toEqual([]);
  });
});
