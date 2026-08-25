import { describe, expect, it } from "vitest";
import { PRODUCT_DIMENSIONS, type ProductDimension } from "./dimension.ts";
import type { DimensionJudgement } from "./judgement.ts";
import { PRODUCT_NOT_RUN, parseProductJudgement } from "./judgement.ts";

function evidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    surfaceId: "home",
    viewport: "desktop",
    screenshot: "screenshots/home-desktop.png",
    observation: "heading and body copy differ only in weight",
    ...overrides,
  };
}

function graded(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "graded",
    grade: "good",
    evidence: [evidence()],
    strengths: ["consistent type family"],
    weaknesses: [],
    ...overrides,
  };
}

function allDimensions(
  overrides: Partial<Record<ProductDimension, unknown>> = {},
): Record<string, unknown> {
  return Object.fromEntries(
    PRODUCT_DIMENSIONS.map((dimension) => [dimension, overrides[dimension] ?? graded()]),
  );
}

function judgement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "judged",
    judge: { source: "scripted", rubricVersion: "rubric-v1" },
    dimensions: allDimensions(),
    polish: graded(),
    ...overrides,
  };
}

describe("parsing a product judgement", () => {
  it("accepts a complete judgement", () => {
    const parsed = parseProductJudgement(judgement());

    expect(parsed.ok).toBe(true);
  });

  it("accepts the not-run answer every free run gives", () => {
    const parsed = parseProductJudgement(PRODUCT_NOT_RUN);

    expect(parsed.ok).toBe(true);
  });

  /**
   * The whole reason the report is worth reading. An unevidenced grade is an opinion, and a
   * reviewer would have to take it on trust; a prompt can ask for evidence, but only a schema
   * can refuse a judgement without it.
   */
  it("refuses a graded dimension carrying no evidence", () => {
    const parsed = parseProductJudgement(
      judgement({ dimensions: allDimensions({ typography: graded({ evidence: [] }) }) }),
    );

    expect(parsed.ok).toBe(false);
  });

  it("requires every piece of evidence to name the screenshot it came from", () => {
    const withoutScreenshot = evidence();
    delete withoutScreenshot.screenshot;

    const parsed = parseProductJudgement(
      judgement({
        dimensions: allDimensions({ color: graded({ evidence: [withoutScreenshot] }) }),
      }),
    );

    expect(parsed.ok).toBe(false);
  });

  /** An archive that is moved must not half-resolve; the same rule screenshot refs answer to. */
  it("refuses evidence pointing outside the results directory", () => {
    for (const path of ["/tmp/home.png", "../elsewhere/home.png"]) {
      const parsed = parseProductJudgement(
        judgement({
          dimensions: allDimensions({
            layout: graded({ evidence: [evidence({ screenshot: path })] }),
          }),
        }),
      );

      expect(parsed.ok, `expected ${path} to be refused`).toBe(false);
    }
  });

  /**
   * A silently missing dimension shrinks the denominator, and a shrinking denominator raises
   * the score. A judge that skipped one has to say so and say why.
   */
  it("refuses a judgement that omits a dimension", () => {
    const missing = allDimensions();
    delete missing.restraint;

    const parsed = parseProductJudgement(judgement({ dimensions: missing }));

    expect(parsed.ok).toBe(false);
  });

  it("requires a reason when a dimension could not be assessed", () => {
    const withReason = parseProductJudgement(
      judgement({
        dimensions: allDimensions({
          responsiveness: { status: "not_assessable", reason: "no mobile capture was taken" },
        }),
      }),
    );
    const withoutReason = parseProductJudgement(
      judgement({ dimensions: allDimensions({ responsiveness: { status: "not_assessable" } }) }),
    );

    expect(withReason.ok).toBe(true);
    expect(withoutReason.ok).toBe(false);
  });

  /** No representable state carries both a grade and a reason it could not be graded. */
  it("refuses a dimension that is both graded and unassessable", () => {
    const parsed = parseProductJudgement(
      judgement({
        dimensions: allDimensions({
          spacing: { status: "not_assessable", reason: "nothing rendered", grade: "poor" },
        }),
      }),
    );

    expect(parsed.ok).toBe(false);
  });

  it("refuses a judgement with no attribution", () => {
    const anonymous = judgement();
    delete anonymous.judge;

    expect(parseProductJudgement(anonymous).ok).toBe(false);
  });

  it("requires the rubric version, not just who judged", () => {
    const parsed = parseProductJudgement(judgement({ judge: { source: "scripted" } }));

    expect(parsed.ok).toBe(false);
  });

  /**
   * `polish` is the judge's holistic read and lives beside the dimensions, never inside them.
   * A judgement that smuggles it into the record is refused rather than silently averaged.
   */
  it("refuses polish as a member of the dimensions", () => {
    const parsed = parseProductJudgement(
      judgement({ dimensions: { ...allDimensions(), polish: graded() } }),
    );

    expect(parsed.ok).toBe(false);
  });

  it("requires the holistic read to be present", () => {
    const withoutPolish = judgement();
    delete withoutPolish.polish;

    expect(parseProductJudgement(withoutPolish).ok).toBe(false);
  });

  it("keeps confidence optional rather than defaulting it", () => {
    const parsed = parseProductJudgement(judgement());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    if (parsed.value.status !== "judged") throw new Error("expected a judged result");

    const typography: DimensionJudgement = parsed.value.dimensions.typography;
    expect(typography.status === "graded" && typography.confidence).toBeUndefined();
  });

  it("carries confidence through when a judge reports it", () => {
    const parsed = parseProductJudgement(
      judgement({ dimensions: allDimensions({ hierarchy: graded({ confidence: "low" }) }) }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    if (parsed.value.status !== "judged") throw new Error("expected a judged result");

    const hierarchy: DimensionJudgement = parsed.value.dimensions.hierarchy;
    expect(hierarchy.status === "graded" && hierarchy.confidence).toBe("low");
  });

  it("refuses an unknown field rather than ignoring it", () => {
    const parsed = parseProductJudgement(judgement({ overallScore: 72 }));

    expect(parsed.ok).toBe(false);
  });
});
