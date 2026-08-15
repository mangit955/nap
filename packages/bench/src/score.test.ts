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
    build: false,
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

/** Effective weights summed in tenths, where the apportionment is exact. */
function totalTenths(categories: { effectiveWeight: number }[]): number {
  return categories.reduce((sum, entry) => sum + Math.round(entry.effectiveWeight * 10), 0);
}

describe("scoreRun — the recorded weights are the ones the score was made of", () => {
  it("sums the effective weights to exactly 100, whatever the rounding", () => {
    // Three equal categories round to 33.3 each and lose 0.1 if each is rounded alone.
    const scored = scoreRun(
      [check("functional", "passed"), check("browser", "passed"), check("code", "failed")],
      { functional: 1, browser: 1, visual: 1, code: 1 },
    );

    // Summed in tenths: the apportionment is exact there, while adding decimal tenths in
    // binary floating point is not — 33.3 + 33.4 + 33.3 lands on 99.99999999999999.
    expect(totalTenths(scored.categories)).toBe(1000);
  });

  it("sums to exactly 100 when independent rounding would overshoot", () => {
    // 55.6 + 27.8 + 16.7 = 100.1 if each is rounded on its own.
    const scored = scoreRun(
      [check("functional", "passed"), check("browser", "passed"), check("visual", "passed")],
      DEFAULT_CATEGORY_WEIGHTS,
    );

    expect(totalTenths(scored.categories)).toBe(1000);
  });

  it("agrees with the overall recomputed from the numbers it recorded", () => {
    // The property the whole apportionment exists for: a reader with only the report can
    // reproduce its headline number exactly, rather than to within a rounding error.
    const scored = scoreRun(
      [
        check("functional", "failed"),
        check("browser", "passed"),
        check("browser", "failed"),
        check("code", "passed"),
      ],
      DEFAULT_CATEGORY_WEIGHTS,
    );

    const byHand = Math.round(
      scored.categories.reduce(
        (sum, entry) => sum + (entry.score * entry.effectiveWeight) / 100,
        0,
      ),
    );
    expect(scored.overall).toBe(byHand);
  });
});

describe("scoreRun — weights that are all zero", () => {
  it("splits the run equally when no present category is worth anything", () => {
    // A configured vector may legitimately zero out whatever turned up, and dividing by that
    // total would be NaN. Equal shares is the only reading of "none of these matter" that
    // still yields a number.
    const scored = scoreRun([check("functional", "passed"), check("code", "failed")], {
      functional: 0,
      browser: 25,
      visual: 15,
      code: 0,
    });

    expect(scored.categories.map((entry) => entry.effectiveWeight)).toEqual([50, 50]);
    expect(scored.overall).toBe(50);
  });

  it("splits a category equally when every check in it is weightless", () => {
    // weight: 0 on every check is a task saying "record these, score them evenly".
    const scored = scoreRun(
      [check("functional", "passed", 0), check("functional", "failed", 0)],
      DEFAULT_CATEGORY_WEIGHTS,
    );
    expect(scored.categories[0]?.score).toBe(50);
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

describe("scoreRun — a visual score from an evaluator rather than from checks", () => {
  const threeCategories = () => [
    check("functional", "passed"),
    check("browser", "passed"),
    check("code", "passed"),
  ];

  it("renormalises visual away when no judge ran, which is the default", () => {
    // The whole reason `not_run` is not a zero: with no visual judge built, a perfect run has
    // to be able to reach 100 rather than cap at 85 for a category nobody evaluated.
    const scored = scoreRun(threeCategories(), DEFAULT_CATEGORY_WEIGHTS, undefined);

    expect(scored.categories.map((entry) => entry.category)).not.toContain("visual");
    expect(scored.overall).toBe(100);
  });

  it("adds the visual category at its configured weight when a score was supplied", () => {
    const scored = scoreRun(threeCategories(), DEFAULT_CATEGORY_WEIGHTS, 60);

    expect(scored.categories).toContainEqual({
      category: "visual",
      score: 60,
      effectiveWeight: 15,
      checks: 0,
    });
    // 50 + 25 + 10 at 100, plus 15 at 60 — the full four-category vector, no renormalisation.
    expect(scored.overall).toBe(94);
  });

  it("puts visual in canonical order, not at the end where it was added", () => {
    const scored = scoreRun(threeCategories(), DEFAULT_CATEGORY_WEIGHTS, 60);

    expect(scored.categories.map((entry) => entry.category)).toEqual([
      "functional",
      "browser",
      "visual",
      "code",
    ]);
  });

  it("keeps the recorded weights summing to exactly 100 with visual present", () => {
    expect(totalTenths(scoreRun(threeCategories(), DEFAULT_CATEGORY_WEIGHTS, 60).categories)).toBe(
      1000,
    );
  });

  it("scores a visual-only run rather than refusing it", () => {
    // Nothing else measurable, but a judged screenshot is still an observation.
    const scored = scoreRun([], DEFAULT_CATEGORY_WEIGHTS, 40);

    expect(scored.overall).toBe(40);
    expect(scored.categories).toEqual([
      { category: "visual", score: 40, effectiveWeight: 100, checks: 0 },
    ]);
  });

  it("cannot rescue a run whose functional checks failed", () => {
    // A broken application must not score well because something thought it looked nice: a
    // perfect visual score against a wholly failed functional category is still a fail.
    const scored = scoreRun([check("functional", "failed")], DEFAULT_CATEGORY_WEIGHTS, 100);

    expect(scored.overall).toBeLessThan(50);
  });

  it("lets an evaluator's judgement stand over checks that scored into visual", () => {
    // Both sources for one category is a configuration nothing produces today. If it arises,
    // the judge's number is the category's: it looked at the rendered result, while a check
    // measured one property of it. The check count records that the checks were there.
    const scored = scoreRun([check("visual", "failed")], DEFAULT_CATEGORY_WEIGHTS, 80);

    expect(scored.categories).toEqual([
      { category: "visual", score: 80, effectiveWeight: 100, checks: 1 },
    ]);
  });
});
