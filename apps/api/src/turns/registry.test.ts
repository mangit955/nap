import { describe, expect, it } from "vitest";
import { TurnRegistry } from "./registry.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const OTHER = "1c8e9a2f-4d3b-4e6c-8f7a-2b3c4d5e6f70";

describe("TurnRegistry", () => {
  it("aborts the adopted turn's controller on a matching cancel", () => {
    const registry = new TurnRegistry();
    const controller = new AbortController();
    registry.adopt(SESSION, controller);

    expect(registry.cancel(SESSION)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("reports that there was nothing to cancel here", () => {
    // Either the turn ended as the user clicked, or it is running on another pod. Both are races
    // rather than failures, and the durable `cancel_requested` has already reached the second.
    const registry = new TurnRegistry();

    expect(registry.cancel(SESSION)).toBe(false);
  });

  it("forgets a turn once it is released", () => {
    // Without this, cancelling after a turn ends aborts a controller nobody is holding, and the
    // *next* turn on the session inherits an already-aborted signal.
    const registry = new TurnRegistry();
    const controller = new AbortController();
    registry.adopt(SESSION, controller);

    registry.release(SESSION, controller);

    expect(registry.cancel(SESSION)).toBe(false);
  });

  it("does not let a later turn's completion cancel the one running now", () => {
    // A slow turn that settles after the next has begun would otherwise clear the entry the new
    // turn depends on, silently disabling its cancel button.
    const registry = new TurnRegistry();
    const first = new AbortController();
    const second = new AbortController();
    registry.adopt(SESSION, first);
    registry.adopt(SESSION, second);

    registry.release(SESSION, first);

    expect(registry.cancel(SESSION)).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });

  it("aborts the turn it replaces rather than orphaning it", () => {
    // The queue's per-session lease means there should never be a second one; if there ever is,
    // the first must not be left running with nothing able to stop it.
    const registry = new TurnRegistry();
    const first = new AbortController();
    registry.adopt(SESSION, first);

    registry.adopt(SESSION, new AbortController());

    expect(first.signal.aborted).toBe(true);
  });

  it("keeps sessions apart", () => {
    const registry = new TurnRegistry();
    const mine = new AbortController();
    registry.adopt(SESSION, mine);
    registry.adopt(OTHER, new AbortController());

    registry.cancel(OTHER);

    expect(mine.signal.aborted).toBe(false);
  });
});
