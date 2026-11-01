import { describe, expect, it } from "vitest";
import {
  CHECK_TIMEOUT_MS,
  SETUP_EXEC_TIMEOUT_MS,
  SETUP_TIMEOUT_SECONDS,
} from "./command-windows.ts";

/** The one ordering here a provider's deadline can quietly break, with nothing else noticing. */
describe("the command windows", () => {
  it("gives setup's own timeout time to fire and report before the provider steps in", () => {
    expect(SETUP_EXEC_TIMEOUT_MS).toBeGreaterThan(SETUP_TIMEOUT_SECONDS * 1_000);
  });

  it("keeps a check inside what a draining worker waits for", () => {
    // `NAP_DRAIN_TIMEOUT_SECONDS` defaults to 600: one check should be able to finish in a drain.
    expect(CHECK_TIMEOUT_MS).toBeLessThan(600 * 1_000);
  });
});
