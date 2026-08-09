import { setTimeout as sleep } from "node:timers/promises";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { describe, expect, it } from "vitest";
import { InProcessEventBus } from "./in-process-event-bus.ts";

const SESSION_A = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const SESSION_B = "1c8f9f2e-4d3b-4e6c-8f7a-2b3c4d5e6f70";
const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

function event(sessionId: string, seq: number, text: string): StoredEvent {
  return {
    type: "agent.message",
    sessionId,
    turnId: TURN,
    seq,
    createdAt: "2026-08-09T12:00:00.000Z",
    payload: { text },
  };
}

describe("fanout", () => {
  it("delivers to every subscriber of that session", () => {
    const bus = new InProcessEventBus();
    const first: StoredEvent[] = [];
    const second: StoredEvent[] = [];
    bus.subscribe(SESSION_A, (e) => first.push(e));
    bus.subscribe(SESSION_A, (e) => second.push(e));

    const published = event(SESSION_A, 1, "hello");
    bus.publish(published);

    expect(first).toEqual([published]);
    expect(second).toEqual([published]);
  });

  it("delivers nothing to a subscriber of another session", () => {
    const bus = new InProcessEventBus();
    const other: StoredEvent[] = [];
    bus.subscribe(SESSION_B, (e) => other.push(e));

    bus.publish(event(SESSION_A, 1, "hello"));

    expect(other).toEqual([]);
  });

  it("delivers synchronously and in publish order", () => {
    const bus = new InProcessEventBus();
    const seen: number[] = [];
    bus.subscribe(SESSION_A, (e) => seen.push(e.seq));

    bus.publish(event(SESSION_A, 1, "one"));
    bus.publish(event(SESSION_A, 2, "two"));

    // No await: an event that only arrives on a later tick would let a caller observe
    // "published" before the subscriber has it, which is what the append-before-publish
    // assertions elsewhere rely on not happening.
    expect(seen).toEqual([1, 2]);
  });

  it("lets a handler's failure reach the publisher", () => {
    const bus = new InProcessEventBus();
    bus.subscribe(SESSION_A, () => {
      throw new Error("subscriber is broken");
    });

    // Swallowing this would hide a broken subscriber behind a green test.
    expect(() => bus.publish(event(SESSION_A, 1, "hello"))).toThrow("subscriber is broken");
  });
});

describe("unsubscribe", () => {
  it("stops delivery to that handler and no other", () => {
    const bus = new InProcessEventBus();
    const staying: StoredEvent[] = [];
    const leaving: StoredEvent[] = [];
    bus.subscribe(SESSION_A, (e) => staying.push(e));
    const unsubscribe = bus.subscribe(SESSION_A, (e) => leaving.push(e));

    unsubscribe();
    bus.publish(event(SESSION_A, 1, "after"));

    expect(leaving).toEqual([]);
    expect(staying).toHaveLength(1);
  });

  it("is idempotent", () => {
    const bus = new InProcessEventBus();
    const unsubscribe = bus.subscribe(SESSION_A, () => {});
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });

  it("does not disturb a fanout already in flight", () => {
    const bus = new InProcessEventBus();
    const seen: string[] = [];
    let unsubscribeSecond: (() => void) | undefined;

    bus.subscribe(SESSION_A, () => {
      seen.push("first");
      // A WebSocket client that closes while being written to does exactly this.
      unsubscribeSecond?.();
    });
    unsubscribeSecond = bus.subscribe(SESSION_A, () => seen.push("second"));

    bus.publish(event(SESSION_A, 1, "hello"));

    // The subscriber that left mid-delivery still receives the event being delivered;
    // it just receives no later one.
    expect(seen).toEqual(["first", "second"]);

    bus.publish(event(SESSION_A, 2, "next"));
    expect(seen).toEqual(["first", "second", "first"]);
  });
});

describe("many subscribers on one session", () => {
  it("emits no max-listeners warning", async () => {
    const warnings: Error[] = [];
    const record = (warning: Error) => warnings.push(warning);
    process.on("warning", record);

    try {
      const bus = new InProcessEventBus();
      // One session can have many open browser tabs. Node's default ceiling is 10, and a
      // warning per connection past that would be noise in production logs.
      for (let i = 0; i < 50; i++) bus.subscribe(SESSION_A, () => {});
      // process.emitWarning fires on a later tick, so a synchronous assertion would pass
      // even if the warning were on its way.
      await sleep(0);
    } finally {
      process.off("warning", record);
    }

    expect(warnings.map((w) => w.name)).not.toContain("MaxListenersExceededWarning");
  });

  it("delivers to all of them", () => {
    const bus = new InProcessEventBus();
    let delivered = 0;
    for (let i = 0; i < 50; i++) bus.subscribe(SESSION_A, () => delivered++);

    bus.publish(event(SESSION_A, 1, "hello"));

    expect(delivered).toBe(50);
  });
});
