import { describe, expect, it } from "vitest";
import { isStartingUp, type StartingUpInputs } from "./starting-up.ts";

/**
 * The frames a component test cannot reach: rendering flushes effects inside the same `act`, so
 * the gap between a paint and the effect that starts a project never occurs there. It occurs in
 * a browser on every single open, which is where the flash came from.
 */

function inputs(overrides: Partial<StartingUpInputs> = {}): StartingUpInputs {
  return {
    status: "ready",
    resuming: false,
    putAwayAt: undefined,
    resumeError: undefined,
    ...overrides,
  };
}

describe("is this project starting up", () => {
  it("says yes before the record has even arrived", () => {
    // Nothing is known yet. Deriving a state from an empty log here is how the pane came to
    // announce "Nothing running yet" about a project that was running.
    expect(isStartingUp(inputs({ status: "loading" }))).toBe(true);
  });

  it("says yes in the gap between the record and the request", () => {
    // The clause that fixes the flash. The record says the project is not running, nothing has
    // refused to start it, and the effect that will start it has not run yet.
    expect(isStartingUp(inputs({ putAwayAt: "2026-08-09T12:00:00.000Z" }))).toBe(true);
  });

  it("says yes while the request is in flight", () => {
    expect(isStartingUp(inputs({ resuming: true, putAwayAt: undefined }))).toBe(true);
  });

  it("says no once a start has been refused", () => {
    // Otherwise the pane claims to be starting a project that nothing is starting, and hides
    // the one screen carrying the button that could actually fix it.
    expect(
      isStartingUp(
        inputs({
          putAwayAt: "2026-08-09T12:00:00.000Z",
          resumeError: "You already have 2 projects running.",
        }),
      ),
    ).toBe(false);
  });

  it("says no for a project that is simply running", () => {
    // No record of it being put away means it has a sandbox: whatever the log says is the truth,
    // and this must not paint over it.
    expect(isStartingUp(inputs())).toBe(false);
  });

  it("says no for a project that has never run", () => {
    // A new project reports no `putAwayAt` — it was never put anywhere — and its pane should be
    // inviting a first prompt rather than pretending to start something.
    expect(isStartingUp(inputs({ status: "ready" }))).toBe(false);
  });

  it("says no for a project that is gone", () => {
    expect(isStartingUp(inputs({ status: "missing" }))).toBe(false);
    expect(isStartingUp(inputs({ status: "error" }))).toBe(false);
  });
});
