import { describe, expect, it } from "vitest";
import { CheckOutcomeSchema } from "./check-outcome.ts";

describe("CheckOutcomeSchema", () => {
  it("admits exactly the three outcomes", () => {
    expect(CheckOutcomeSchema.options).toEqual(["passed", "failed", "absent"]);
  });

  it("rejects a boolean-shaped answer", () => {
    // The whole point of three values is that a check which was never asked is not a check
    // that said no. A caller reaching for true/false has lost that distinction.
    expect(CheckOutcomeSchema.safeParse("true").success).toBe(false);
    expect(CheckOutcomeSchema.safeParse("skipped").success).toBe(false);
  });
});
