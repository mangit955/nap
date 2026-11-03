import { describe, expect, it } from "vitest";
import { TurnRegistry } from "./registry.ts";

const REQUEST = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const OTHER = "1c8e9a2f-4d3b-4e6c-8f7a-2b3c4d5e6f70";

describe("TurnRegistry", () => {
  it("aborts the adopted turn's controller on a matching cancel", () => {
    const registry = new TurnRegistry();
    const controller = new AbortController();
    registry.adopt(REQUEST, controller);

    expect(registry.cancel(REQUEST)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toMatchObject({ code: "cancelled" });
  });

  it("reports that there was nothing to cancel here", () => {
    // Either the turn ended as the user clicked, or it is running on another pod. Both are races
    // rather than failures, and the durable `cancel_requested` has already reached the second.
    const registry = new TurnRegistry();

    expect(registry.cancel(REQUEST)).toBe(false);
  });

  it("forgets a turn once it is released", () => {
    // Without this, every finished request stays in memory holding its controller for as long as
    // the process lives, and a late cancel reports reaching a turn that has already ended.
    const registry = new TurnRegistry();
    const controller = new AbortController();
    registry.adopt(REQUEST, controller);

    registry.release(REQUEST, controller);

    expect(registry.cancel(REQUEST)).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it("keeps requests apart", () => {
    const registry = new TurnRegistry();
    const mine = new AbortController();
    registry.adopt(REQUEST, mine);
    registry.adopt(OTHER, new AbortController());

    registry.cancel(OTHER);

    expect(mine.signal.aborted).toBe(false);
  });
});
