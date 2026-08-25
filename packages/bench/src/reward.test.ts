import { describe, expect, it } from "vitest";
import type { ErrorKind } from "./error-kind.ts";
import { rewardFor } from "./reward.ts";
import { benchReport } from "./testing/bench-report.ts";

describe("projecting a report into a reward", () => {
  it("reports the overall score on a 0–1 scale", () => {
    const reward = rewardFor(benchReport({ score: 88 }));

    expect(reward?.overall).toBeCloseTo(0.88);
  });

  it("carries a failed run's score, because a failure is still a measurement", () => {
    const reward = rewardFor(benchReport({ status: "failed", score: 31 }));

    expect(reward?.overall).toBeCloseTo(0.31);
  });

  /**
   * The rule the whole migration turns on. An external harness's reward is numeric with no
   * null, so an unmeasured run has only two honest destinations — zero or nothing — and zero
   * would convert our infrastructure failing into the model's bad result.
   */
  it.each<ErrorKind>(["sandbox", "browser", "configuration", "runtime", "model", "evaluator"])(
    "produces no reward at all for a run that errored with kind %s",
    (errorKind) => {
      const reward = rewardFor(
        benchReport({ status: "errored", errorKind, score: null, scoreCap: null }),
      );

      expect(reward).toBeUndefined();
    },
  );

  /**
   * `agent` is the one kind that *is* evidence about the model — but it is still not a score.
   * A suite counts it into an error rate; it does not average it in as a zero.
   */
  it("produces no reward for an agent failure either", () => {
    const reward = rewardFor(
      benchReport({ status: "errored", errorKind: "agent", score: null, scoreCap: null }),
    );

    expect(reward).toBeUndefined();
  });

  it("produces no reward for a cancelled run", () => {
    const reward = rewardFor(benchReport({ status: "cancelled", score: null }));

    expect(reward).toBeUndefined();
  });

  /** No path returns zero for an unmeasured run — the mistake this file exists to prevent. */
  it("never reports a zero in place of an absence", () => {
    for (const status of ["errored", "cancelled"] as const) {
      const reward = rewardFor(
        benchReport({
          status,
          errorKind: status === "errored" ? "sandbox" : null,
          score: null,
        }),
      );

      expect(reward).not.toEqual({ overall: 0 });
      expect(reward).toBeUndefined();
    }
  });

  it("names both halves when the run was scored with them", () => {
    const reward = rewardFor(
      benchReport({ score: 49, scoringModel: "v2", halves: { objective: 95, product: 25 } }),
    );

    expect(reward?.objective).toBeCloseTo(0.95);
    expect(reward?.product).toBeCloseTo(0.25);
  });

  /** An unjudged v2 run has an objective half and no product one. Absence, not zero. */
  it("omits the product half rather than reporting it as zero when nobody judged", () => {
    const reward = rewardFor(
      benchReport({ score: 85, scoringModel: "v2", halves: { objective: 85, product: null } }),
    );

    expect(reward?.objective).toBeCloseTo(0.85);
    expect(reward).not.toHaveProperty("product");
  });

  it("decomposes into the categories, so a consumer can see which half moved", () => {
    const reward = rewardFor(
      benchReport({
        score: 70,
        categories: [
          { category: "functional", score: 100, effectiveWeight: 60, checks: 2 },
          { category: "browser", score: 40, effectiveWeight: 40, checks: 1 },
        ],
      }),
    );

    expect(reward?.functional).toBeCloseTo(1);
    expect(reward?.browser).toBeCloseTo(0.4);
  });
});
