import { describe, expect, it } from "vitest";
import { POLISH, PRODUCT_DIMENSIONS, type ProductDimension } from "./dimension.ts";
import { anchorFor, GRADE_ANCHORS, type Grade } from "./grade.ts";
import type { DimensionJudgement, ProductJudgement } from "./judgement.ts";
import { combineHalves, scoreProduct } from "./product-score.ts";

function graded(grade: Grade): DimensionJudgement {
  return {
    status: "graded",
    grade,
    evidence: [
      {
        surfaceId: "home",
        viewport: "desktop",
        screenshot: "screenshots/home-desktop.png",
        observation: "observed",
      },
    ],
    strengths: [],
    weaknesses: [],
  };
}

const unassessable: DimensionJudgement = {
  status: "not_assessable",
  reason: "nothing rendered on this surface",
};

function judged(
  overrides: Partial<Record<ProductDimension, DimensionJudgement>> = {},
  polish: DimensionJudgement = graded("good"),
): ProductJudgement {
  return {
    status: "judged",
    judge: { source: "scripted", rubricVersion: "rubric-v1" },
    dimensions: Object.fromEntries(
      PRODUCT_DIMENSIONS.map((dimension) => [dimension, overrides[dimension] ?? graded("good")]),
    ) as Record<ProductDimension, DimensionJudgement>,
    polish,
  };
}

describe("scoring the product half", () => {
  it("is the equally weighted mean of the anchors", () => {
    const score = scoreProduct(judged());

    expect(score?.score).toBe(GRADE_ANCHORS.good);
    expect(score?.assessed).toBe(PRODUCT_DIMENSIONS.length);
  });

  it("maps every grade through the fixed anchors rather than inventing a number", () => {
    const score = scoreProduct(judged({ typography: graded("poor") }));

    const expected =
      (anchorFor("good") * (PRODUCT_DIMENSIONS.length - 1) + anchorFor("poor")) /
      PRODUCT_DIMENSIONS.length;
    expect(score?.score).toBe(Math.round(expected));
  });

  it("lists dimensions in canonical order, whatever order they were judged in", () => {
    const score = scoreProduct(judged());

    expect(score?.dimensions.map((entry) => entry.dimension)).toEqual([...PRODUCT_DIMENSIONS]);
  });

  /**
   * The distinction the whole scheme rests on. A judge that could not see a surface must not be
   * able to lower a score by saying so — that is a fact about the run's circumstances, not
   * about the application, and it renormalises exactly as an absent category does.
   */
  it("treats not_assessable as absent, not as the worst grade", () => {
    const absent = scoreProduct(judged({ responsiveness: unassessable }));
    const poor = scoreProduct(judged({ responsiveness: graded("poor") }));

    expect(absent?.score).toBe(GRADE_ANCHORS.good);
    expect(absent?.assessed).toBe(PRODUCT_DIMENSIONS.length - 1);
    expect(poor?.score).toBeLessThan(absent?.score ?? 0);
  });

  it("reports nothing when the judge did not run", () => {
    expect(scoreProduct({ status: "not_run", reason: "no judge configured" })).toBeUndefined();
  });

  /** A mean over an empty set is not a low score. Nothing was measured. */
  it("reports nothing when every dimension was unassessable", () => {
    const nothing = Object.fromEntries(
      PRODUCT_DIMENSIONS.map((dimension) => [dimension, unassessable]),
    ) as Partial<Record<ProductDimension, DimensionJudgement>>;

    expect(scoreProduct(judged(nothing))).toBeUndefined();
  });

  /**
   * `polish` summarises the nine; averaging it in would count them twice, and it is the least
   * evidence-anchored thing the judge produces. It is excluded structurally — it is not in
   * `PRODUCT_DIMENSIONS` — so this pins that the structure actually holds.
   */
  it("never lets the holistic read enter the computed score", () => {
    const excellent = scoreProduct(judged({}, graded("excellent")));
    const dreadful = scoreProduct(judged({}, graded("poor")));

    expect(excellent?.score).toBe(dreadful?.score);
    expect(excellent?.dimensions.map((entry) => entry.dimension)).not.toContain(POLISH);
  });
});

describe("combining the halves", () => {
  it("multiplies rather than averages, so neither half carries the other", () => {
    // A weighted mean of 95 and 25 would be somewhere in the seventies. This is not that.
    expect(combineHalves(95, 25)).toBe(49);
  });

  it("scores a correct and beautiful application highly", () => {
    expect(combineHalves(95, 90)).toBe(92);
  });

  it("refuses to reward a correct application that looks terrible", () => {
    expect(combineHalves(100, 12)).toBeLessThan(40);
  });

  it("refuses to reward a beautiful application that does not work", () => {
    expect(combineHalves(20, 95)).toBeLessThan(50);
  });

  it("is symmetric — neither half is privileged", () => {
    expect(combineHalves(30, 90)).toBe(combineHalves(90, 30));
  });

  /**
   * The archive predates the judge, and every free run has none. Scoring an absent half at zero
   * would retroactively halve every number ever recorded.
   */
  it("scores an unjudged run on the objective half alone", () => {
    expect(combineHalves(85, undefined)).toBe(85);
  });

  it("never exceeds the better half or falls below the worse one", () => {
    for (const [objective, product] of [
      [95, 25],
      [40, 80],
      [70, 70],
      [12, 12],
    ] as const) {
      const overall = combineHalves(objective, product);

      expect(overall).toBeGreaterThanOrEqual(Math.min(objective, product) - 1);
      expect(overall).toBeLessThanOrEqual(Math.max(objective, product) + 1);
    }
  });
});
