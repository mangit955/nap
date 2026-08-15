import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  CategoryWeightsSchema,
  DEFAULT_CATEGORY_FOR_KIND,
  DEFAULT_CATEGORY_WEIGHTS,
} from "./category.ts";

describe("the default weights", () => {
  it("are 50/25/15/10", () => {
    // Stated here rather than inferred from a score, because it is the one number in the
    // benchmark that expresses what NapBench thinks matters, and changing it silently
    // reprices every run.
    expect(DEFAULT_CATEGORY_WEIGHTS).toEqual({
      functional: 50,
      browser: 25,
      visual: 15,
      code: 10,
    });
  });

  it("sum to 100, so a run with every category present needs no rescaling", () => {
    const total = Object.values(DEFAULT_CATEGORY_WEIGHTS).reduce((sum, w) => sum + w, 0);
    expect(total).toBe(100);
  });

  it("cover every category, so none can be silently unweighted", () => {
    expect(Object.keys(DEFAULT_CATEGORY_WEIGHTS).toSorted()).toEqual([...CATEGORIES].toSorted());
  });
});

describe("the weights schema", () => {
  it("refuses a negative weight", () => {
    expect(CategoryWeightsSchema.safeParse({ ...DEFAULT_CATEGORY_WEIGHTS, code: -1 }).success).toBe(
      false,
    );
  });

  it("refuses a vector missing a category", () => {
    expect(
      CategoryWeightsSchema.safeParse({ functional: 50, browser: 25, visual: 15 }).success,
    ).toBe(false);
  });

  it("accepts a vector that does not sum to 100, since only the ratios are used", () => {
    const parsed = CategoryWeightsSchema.safeParse({
      functional: 1,
      browser: 1,
      visual: 0,
      code: 0,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("the default category for a kind", () => {
  it("puts a command in functional", () => {
    expect(DEFAULT_CATEGORY_FOR_KIND.command).toBe("functional");
  });
});
