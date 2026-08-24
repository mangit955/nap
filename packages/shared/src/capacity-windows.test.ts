import { describe, expect, it } from "vitest";
import { RESERVATION_TTL_MS, STRANDED_GRACE_MS } from "./capacity-windows.ts";

/**
 * One assertion, and it is the only thing in the repo that would notice these two being edited
 * out of order. Both numbers look arbitrary on their own; their *relationship* is what stops the
 * sweep that repairs the ceiling from destroying sandboxes the ceiling is still creating.
 */
describe("the sandbox capacity windows", () => {
  it("waits longer to call something stranded than a reservation may live", () => {
    expect(STRANDED_GRACE_MS).toBeGreaterThan(RESERVATION_TTL_MS);
  });
});
