import { describe, expect, it } from "vitest";
import { DEFAULT_CATEGORY_WEIGHTS } from "./category.ts";
import type { CheckResult } from "./report.ts";
import { scoreRun } from "./score.ts";

function check(
  category: CheckResult["category"],
  outcome: CheckResult["outcome"],
  weight = 1,
): CheckResult {
  return {
    checkId: `${category}-${outcome}-${weight}-${Math.random()}`,
    kind: "command",
    category,
    weight,
    required: false,
    outcome,
    detail: outcome,
  };
}

describe("scoreRun — a category's own score", () => {
  it("is the proportion of its checks that passed", () => {
    const scored = scoreRun(
      [check("functional", "passed"), check("functional", "failed")],
      DEFAULT_CATEGORY_WEIGHTS,
    );
    expect(scored.categories).toEqual([
      { category: "functional", score: 50, effectiveWeight: 100, checks: 2 },
    ]);
  });

  it("weights checks within the category against each other", () => {
    // A core behaviour outweighing a cosmetic one is the whole reason weights exist.
    const scored = scoreRun(
      [check("functional", "passed", 3), check("functional", "failed", 1)],
      DEFAULT_CATEGORY_WEIGHTS,
    );
    expect(scored.categories[0]?.score).toBe(75);
  });

  it("is 100 when everything in it passed", () => {
    const scored = scoreRun([check("code", "passed")], DEFAULT_CATEGORY_WEIGHTS);
    expect(scored.categories[0]?.score).toBe(100);
  });
});

describe("scoreRun — the overall score", () => {
  it("is the weighted mean across categories", () => {
    // functional 100 at 50, code 0 at 10 → renormalised 83.3/16.7 → 83.
    const scored = scoreRun(
      [check("functional", "passed"), check("code", "failed")],
      DEFAULT_CATEGORY_WEIGHTS,
    );
    expect(scored.overall).toBe(83);
  });

  it("is reproducible by hand from the check list and the configured weights", () => {
    // The property that makes a number quotable: functional 50% of its checks, browser 100%,
    // weights 50 and 25 renormalised to 2/3 and 1/3 → 50*(2/3) + 100*(1/3) = 66.67 → 67.
    const scored = scoreRun(
      [check("functional", "passed"), check("functional", "failed"), check("browser", "passed")],
      DEFAULT_CATEGORY_WEIGHTS,
    );
    expect(scored.overall).toBe(67);
  });

  it("is a whole number on the same 0-100 scale as every other run", () => {
    const scored = scoreRun([check("visual", "passed")], DEFAULT_CATEGORY_WEIGHTS);
    expect(scored.overall).toBe(100);
    expect(Number.isInteger(scored.overall)).toBe(true);
  });

  it("takes configured weights, not the defaults", () => {
    // Same checks, different priorities: code made to matter more than functional.
    const scored = scoreRun([check("functional", "passed"), check("code", "failed")], {
      functional: 10,
      browser: 25,
      visual: 15,
      code: 90,
    });
    expect(scored.overall).toBe(10);
  });
});

describe("scoreRun — renormalisation, per docs/adr/0002", () => {
  it("drops categories nothing scored into and rescales the rest to sum to 100", () => {
    // The ADR's worked example: visual absent, so 50/25/10 becomes 58.8/29.4/11.8.
    const scored = scoreRun(
      [check("functional", "passed"), check("browser", "passed"), check("code", "passed")],
      DEFAULT_CATEGORY_WEIGHTS,
    );

    expect(scored.categories.map((entry) => entry.effectiveWeight)).toEqual([58.8, 29.4, 11.8]);
    expect(scored.categories.map((entry) => entry.category)).not.toContain("visual");
  });

  it("does not let an unbuilt evaluator drag every score down", () => {
    // The reason the ADR chose renormalising over scoring absent categories zero: with
    // visual unimplemented, a perfect run must still be able to reach 100.
    const scored = scoreRun(
      [check("functional", "passed"), check("browser", "passed"), check("code", "passed")],
      DEFAULT_CATEGORY_WEIGHTS,
    );
    expect(scored.overall).toBe(100);
  });

  it("gives one present category all of the weight", () => {
    const scored = scoreRun([check("code", "failed")], DEFAULT_CATEGORY_WEIGHTS);
    expect(scored.categories[0]?.effectiveWeight).toBe(100);
    expect(scored.overall).toBe(0);
  });

  it("reports the categories in a stable order regardless of check order", () => {
    // Two reports of the same run must diff as identical.
    const order = (results: CheckResult[]) =>
      scoreRun(results, DEFAULT_CATEGORY_WEIGHTS).categories.map((entry) => entry.category);

    expect(order([check("code", "passed"), check("functional", "passed")])).toEqual(
      order([check("functional", "passed"), check("code", "passed")]),
    );
  });
});

describe("scoreRun — absent is not failed, which is the sharp edge", () => {
  it("drops a category whose every check was absent", () => {
    // Absent means the task never got to ask — a property of the run's circumstances.
    const scored = scoreRun(
      [check("functional", "passed"), check("browser", "absent")],
      DEFAULT_CATEGORY_WEIGHTS,
    );
    expect(scored.categories.map((entry) => entry.category)).toEqual(["functional"]);
    expect(scored.overall).toBe(100);
  });

  it("counts a failed check against its category rather than dropping it", () => {
    // And failing must never renormalise: if "could not run" dropped the browser category,
    // an application that never started would have its 25% handed to categories that did
    // run, and failing to start would *raise* the score. ADR-0002 calls this the case the
    // tests exist to pin.
    const failed = scoreRun(
      [check("functional", "passed"), check("browser", "failed")],
      DEFAULT_CATEGORY_WEIGHTS,
    );
    const absent = scoreRun(
      [check("functional", "passed"), check("browser", "absent")],
      DEFAULT_CATEGORY_WEIGHTS,
    );

    expect(failed.overall ?? 0).toBeLessThan(absent.overall ?? 0);
    expect(failed.overall).toBe(67);
  });

  it("ignores absent checks inside a category that did produce results", () => {
    // One browser check ran and passed, another never got to; the category scores on what
    // was actually observed rather than counting the absent one as a failure.
    const scored = scoreRun(
      [check("browser", "passed"), check("browser", "absent")],
      DEFAULT_CATEGORY_WEIGHTS,
    );
    expect(scored.categories[0]?.score).toBe(100);
    expect(scored.categories[0]?.checks).toBe(1);
  });

  it("has no score at all when nothing produced a result", () => {
    // Not zero: a run where nothing could be measured is not a run that scored badly.
    const scored = scoreRun([check("browser", "absent")], DEFAULT_CATEGORY_WEIGHTS);
    expect(scored.overall).toBeNull();
    expect(scored.categories).toEqual([]);
  });

  it("has no score for an empty check list", () => {
    expect(scoreRun([], DEFAULT_CATEGORY_WEIGHTS).overall).toBeNull();
  });
});
