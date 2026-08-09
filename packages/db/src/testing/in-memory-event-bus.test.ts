import type { StoredEvent } from "@nap/shared/ports/event-store";
import { describe, expect, it } from "vitest";
import { InMemoryEventBus } from "./in-memory-event-bus.ts";

const SESSION_A = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const SESSION_B = "9f1c7d3e-5b2a-4c8d-9e0f-1a2b3c4d5e6f";
const TURN = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";

function event(sessionId: string, seq: number): StoredEvent {
  return {
    type: "turn.started",
    sessionId,
    turnId: TURN,
    seq,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {},
  };
}

describe("InMemoryEventBus", () => {
  it("delivers to every subscriber of the session", () => {
    const bus = new InMemoryEventBus();
    const first: StoredEvent[] = [];
    const second: StoredEvent[] = [];
    bus.subscribe(SESSION_A, (e) => first.push(e));
    bus.subscribe(SESSION_A, (e) => second.push(e));

    bus.publish(event(SESSION_A, 1));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it("delivers only to subscribers of the event's own session", () => {
    const bus = new InMemoryEventBus();
    const received: StoredEvent[] = [];
    bus.subscribe(SESSION_B, (e) => received.push(e));

    bus.publish(event(SESSION_A, 1));

    expect(received).toEqual([]);
  });

  it("stops delivering once unsubscribed", () => {
    const bus = new InMemoryEventBus();
    const received: StoredEvent[] = [];
    const unsubscribe = bus.subscribe(SESSION_A, (e) => received.push(e));

    bus.publish(event(SESSION_A, 1));
    unsubscribe();
    bus.publish(event(SESSION_A, 2));

    expect(received.map((e) => e.seq)).toEqual([1]);
  });

  it("leaves other subscribers alone when one unsubscribes", () => {
    const bus = new InMemoryEventBus();
    const kept: StoredEvent[] = [];
    const dropped = bus.subscribe(SESSION_A, () => {});
    bus.subscribe(SESSION_A, (e) => kept.push(e));

    dropped();
    bus.publish(event(SESSION_A, 1));

    expect(kept).toHaveLength(1);
  });

  it("delivers in publish order", () => {
    const bus = new InMemoryEventBus();
    const received: number[] = [];
    bus.subscribe(SESSION_A, (e) => received.push(e.seq));

    bus.publish(event(SESSION_A, 1));
    bus.publish(event(SESSION_A, 2));
    bus.publish(event(SESSION_A, 3));

    expect(received).toEqual([1, 2, 3]);
  });

  it("publishing with no subscribers is not an error", () => {
    expect(() => new InMemoryEventBus().publish(event(SESSION_A, 1))).not.toThrow();
  });
});
