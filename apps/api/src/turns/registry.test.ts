import { describe, expect, it } from "vitest";
import { TurnRegistry } from "./registry.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const OTHER = "1c8e9a2f-4d3b-4e6c-8f7a-2b3c4d5e6f70";

describe("TurnRegistry", () => {
  it("hands out a signal that the matching cancel aborts", () => {
    const registry = new TurnRegistry();
    const signal = registry.start(SESSION);

    expect(registry.cancel(SESSION)).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it("reports that there was nothing to cancel", () => {
    // The user clicked cancel as the turn was ending. That is a race, not a failure — the
    // route answers it differently from a server error precisely because of this.
    const registry = new TurnRegistry();

    expect(registry.cancel(SESSION)).toBe(false);
  });

  it("forgets a turn once it finishes", () => {
    // Without this, cancelling after a turn ends aborts a controller nobody is holding, and
    // the *next* turn on the session inherits an already-aborted signal.
    const registry = new TurnRegistry();
    registry.start(SESSION);

    registry.finish(SESSION);

    expect(registry.cancel(SESSION)).toBe(false);
  });

  it("does not let a later turn's completion cancel the one running now", () => {
    // A slow turn that finishes after the next has begun would otherwise clear the entry the
    // new turn depends on, silently disabling its cancel button.
    const registry = new TurnRegistry();
    const first = registry.start(SESSION);
    const second = registry.start(SESSION);

    registry.finish(SESSION, first);

    expect(registry.cancel(SESSION)).toBe(true);
    expect(second.aborted).toBe(true);
  });

  it("aborts the turn it replaces rather than orphaning it", () => {
    // One turn per session is the runtime's rule; if a second is ever registered, the first
    // must not be left running with nothing able to stop it.
    const registry = new TurnRegistry();
    const first = registry.start(SESSION);

    registry.start(SESSION);

    expect(first.aborted).toBe(true);
  });

  it("keeps sessions apart", () => {
    const registry = new TurnRegistry();
    const mine = registry.start(SESSION);
    registry.start(OTHER);

    registry.cancel(OTHER);

    expect(mine.aborted).toBe(false);
  });

  it("knows whether a session has a turn in flight", () => {
    const registry = new TurnRegistry();

    expect(registry.isRunning(SESSION)).toBe(false);
    registry.start(SESSION);
    expect(registry.isRunning(SESSION)).toBe(true);
    registry.finish(SESSION);
    expect(registry.isRunning(SESSION)).toBe(false);
  });
});
