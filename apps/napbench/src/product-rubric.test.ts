import { POLISH, PRODUCT_DIMENSIONS } from "@nap/bench/product/dimension";
import { GRADES } from "@nap/bench/product/grade";
import { describe, expect, it } from "vitest";
import { PRODUCT_RUBRIC, PRODUCT_RUBRIC_VERSION } from "./product-rubric.ts";

describe("PRODUCT_RUBRIC", () => {
  /**
   * The rubric is folded out of `PRODUCT_DIMENSIONS`, so this cannot fail today. It exists for
   * the day somebody replaces the fold with prose — a dimension the schema demands and the
   * rubric never mentions produces a confident guess rather than an error.
   */
  it("explains every dimension the schema will demand an answer for", () => {
    for (const dimension of [...PRODUCT_DIMENSIONS, POLISH]) {
      expect(PRODUCT_RUBRIC).toContain(dimension);
    }
  });

  it("names the whole scale, so no grade is one the judge has to invent", () => {
    for (const grade of GRADES) {
      expect(PRODUCT_RUBRIC).toContain(grade);
    }
  });

  /**
   * Three refusals the rubric is the only place that carries. The schema can insist a grade
   * carries evidence; it cannot insist the judge was told that feature completeness, library
   * identity and accessibility conformance are somebody else's question.
   */
  it("keeps the judge off the objective half's ground", () => {
    expect(PRODUCT_RUBRIC).toContain("specification");
    expect(PRODUCT_RUBRIC).toContain("component library");
    expect(PRODUCT_RUBRIC).toContain("Do not grade accessibility conformance");
  });

  /** The decision that there is no icon dimension only holds if `restraint` is told to carry it. */
  it("asks for icon usage under restraint every time", () => {
    expect(PRODUCT_RUBRIC).toContain("icons");
  });

  /**
   * The anchors are applied in our code, after the judgement, precisely so the judge never sees
   * them — a judge shown numbers starts doing arithmetic instead of making a judgement.
   */
  it("shows the judge no numbers to anchor on", () => {
    expect(PRODUCT_RUBRIC).not.toMatch(/\b\d{2}\b/);
  });
});

describe("PRODUCT_RUBRIC_VERSION", () => {
  /**
   * Not a hash of the text: a hash bumps on a whitespace change and would silently split the
   * archive in two. This is somebody deciding the question has changed.
   */
  it("is a stable stamp rather than a digest", () => {
    expect(PRODUCT_RUBRIC_VERSION).toBe("product-2");
  });
});
