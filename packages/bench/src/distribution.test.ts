import { describe, expect, it } from "vitest";
import { describeDistribution } from "./distribution.ts";

describe("describeDistribution", () => {
  it("summarises a set of scores", () => {
    const distribution = describeDistribution([74, 88, 90]);

    expect(distribution).toEqual({
      n: 3,
      mean: 84,
      median: 88,
      stdDev: 8.7,
      lowest: 74,
      highest: 90,
    });
  });

  it("takes the middle of the two middle values when there is no single middle", () => {
    expect(describeDistribution([70, 80, 90, 100]).median).toBe(85);
  });

  it("does not care what order it is handed the scores in", () => {
    // A suite hands these over in whatever order the runs finished, which is not sorted.
    expect(describeDistribution([90, 74, 88])).toEqual(describeDistribution([74, 88, 90]));
  });

  it("has no standard deviation for a single run", () => {
    // Null rather than zero, and this is the point of the whole module: zero would read as
    // "this model is perfectly consistent" when what happened is that nobody measured twice.
    // The same instinct as the absent metrics in docs/adr/0003 — do not report an unmeasured
    // figure as a measured one.
    const distribution = describeDistribution([88]);

    expect(distribution.n).toBe(1);
    expect(distribution.mean).toBe(88);
    expect(distribution.median).toBe(88);
    expect(distribution.stdDev).toBeNull();
  });

  it("reports zero spread only when the runs really did agree", () => {
    expect(describeDistribution([88, 88, 88]).stdDev).toBe(0);
  });

  it("is null all through when there is nothing to describe", () => {
    // A task whose every run errored has no scores, and a mean of nothing is not zero.
    expect(describeDistribution([])).toEqual({
      n: 0,
      mean: null,
      median: null,
      stdDev: null,
      lowest: null,
      highest: null,
    });
  });
});
