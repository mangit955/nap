import type { PendingEvent } from "@nap/shared/ports/event-store";
import { describe, expect, it } from "vitest";
import { InMemoryEventStore } from "./in-memory-event-store.ts";

const SESSION_A = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const SESSION_B = "9f1c7d3e-5b2a-4c8d-9e0f-1a2b3c4d5e6f";
const TURN = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";

function message(sessionId: string, text: string): PendingEvent {
  return {
    type: "user.message",
    sessionId,
    turnId: TURN,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { text },
  };
}

describe("InMemoryEventStore", () => {
  it("assigns seq starting at 1 and incrementing by one", async () => {
    const store = new InMemoryEventStore();

    const first = await store.append(message(SESSION_A, "one"));
    const second = await store.append(message(SESSION_A, "two"));
    const third = await store.append(message(SESSION_A, "three"));

    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
  });

  it("returns the event it was given, with seq added and nothing else changed", async () => {
    const store = new InMemoryEventStore();
    const pending = message(SESSION_A, "hello");

    const stored = await store.append(pending);

    expect(stored).toStrictEqual({ ...pending, seq: 1 });
  });

  it("counts seq per session, so two sessions do not share a sequence", async () => {
    const store = new InMemoryEventStore();

    await store.append(message(SESSION_A, "a1"));
    await store.append(message(SESSION_A, "a2"));
    const b = await store.append(message(SESSION_B, "b1"));

    expect(b.seq).toBe(1);
  });

  it("reads only events after the given seq, in order", async () => {
    const store = new InMemoryEventStore();
    for (const text of ["one", "two", "three"]) await store.append(message(SESSION_A, text));

    const read = await store.readFrom(SESSION_A, 1);

    expect(read.map((event) => event.seq)).toEqual([2, 3]);
  });

  it("reads everything from seq 0", async () => {
    const store = new InMemoryEventStore();
    await store.append(message(SESSION_A, "one"));
    await store.append(message(SESSION_A, "two"));

    expect(await store.readFrom(SESSION_A, 0)).toHaveLength(2);
  });

  it("never returns another session's events", async () => {
    const store = new InMemoryEventStore();
    await store.append(message(SESSION_A, "mine"));
    await store.append(message(SESSION_B, "theirs"));

    const read = await store.readFrom(SESSION_A, 0);

    expect(read).toHaveLength(1);
    expect(read[0]?.payload).toStrictEqual({ text: "mine" });
  });

  it("returns nothing for a session that has never been written to", async () => {
    expect(await new InMemoryEventStore().readFrom(SESSION_A, 0)).toEqual([]);
  });

  it("writes a second copy of an event when nothing says the first attempt may have landed", async () => {
    // The dedupe is opt-in, and has to be: a turn legitimately emits two identical-looking
    // events, and a store that swallowed the second would lose a line of the transcript.
    const store = new InMemoryEventStore();
    await store.append(message(SESSION_A, "same"));
    await store.append(message(SESSION_A, "same"));

    expect(await store.readFrom(SESSION_A, 0)).toHaveLength(2);
  });

  it("returns the row already written rather than a second one, when told this is a retry", async () => {
    const store = new InMemoryEventStore();
    const pending = message(SESSION_A, "committed, then the connection dropped");
    const first = await store.append(pending);

    const retried = await store.append(pending, { retryAfterSeq: 0 });

    expect(retried).toStrictEqual(first);
    expect(await store.readFrom(SESSION_A, 0)).toHaveLength(1);
  });

  it("writes the second of two identical events, when the first is below the watermark", async () => {
    // Content alone cannot tell a retry's own lost append from the identical event before it.
    const store = new InMemoryEventStore();
    const repeated = message(SESSION_A, "same");
    const first = await store.append(repeated);

    const second = await store.append(repeated, { retryAfterSeq: first.seq });

    expect(second.seq).toBe(2);
    expect(await store.readFrom(SESSION_A, 0)).toHaveLength(2);
  });

  it("still writes a retried event that never landed", async () => {
    const store = new InMemoryEventStore();
    await store.append(message(SESSION_A, "one"));

    const second = await store.append(message(SESSION_A, "two"), { retryAfterSeq: 1 });

    expect(second.seq).toBe(2);
    expect(await store.readFrom(SESSION_A, 0)).toHaveLength(2);
  });

  it("hands out copies, so a caller mutating a read event cannot corrupt the log", async () => {
    const store = new InMemoryEventStore();
    await store.append(message(SESSION_A, "original"));

    const [read] = await store.readFrom(SESSION_A, 0);
    if (read === undefined) throw new Error("expected an event");
    (read.payload as { text: string }).text = "tampered";

    const [again] = await store.readFrom(SESSION_A, 0);
    expect(again?.payload).toStrictEqual({ text: "original" });
  });
});
