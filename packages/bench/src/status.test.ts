import { describe, expect, it } from "vitest";
import { carriesScore, countsInAggregates, RUN_STATUSES, RunStatusSchema } from "./status.ts";

describe("run status", () => {
  it("is one of exactly four answers", () => {
    expect([...RUN_STATUSES]).toEqual(["passed", "failed", "errored", "cancelled"]);
  });

  it("rejects anything else", () => {
    expect(RunStatusSchema.safeParse("aborted").success).toBe(false);
  });
});

describe("carriesScore", () => {
  it("is true for the two statuses that are results", () => {
    expect(carriesScore("passed")).toBe(true);
    expect(carriesScore("failed")).toBe(true);
  });

  it("is false for the two that produced no observation", () => {
    // A scored error is a fabricated number, and a scored cancellation is a number for
    // something nobody finished watching.
    expect(carriesScore("errored")).toBe(false);
    expect(carriesScore("cancelled")).toBe(false);
  });
});

describe("countsInAggregates", () => {
  it("counts an errored run, because a model that errors often is worse", () => {
    expect(countsInAggregates("errored")).toBe(true);
  });

  it("excludes a cancelled run from every aggregate", () => {
    // Somebody pressing stop is a fact about the operator, not about the agent. Counted as
    // an error it would inflate the error rate; counted as a failure it would depress the
    // pass rate. It is not an observation at all, so it is not in the denominator either.
    expect(countsInAggregates("cancelled")).toBe(false);
    expect(countsInAggregates("passed")).toBe(true);
    expect(countsInAggregates("failed")).toBe(true);
  });
});
