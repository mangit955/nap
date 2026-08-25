import { describe, expect, it } from "vitest";
import { DIMENSION_SUMMARIES, POLISH, PRODUCT_DIMENSIONS } from "./dimension.ts";

describe("the product dimensions", () => {
  it("are the nine agreed axes, in reading order", () => {
    expect([...PRODUCT_DIMENSIONS]).toEqual([
      "hierarchy",
      "typography",
      "spacing",
      "color",
      "layout",
      "components",
      "interaction",
      "responsiveness",
      "restraint",
    ]);
  });

  /**
   * The structural guarantee that the holistic read cannot be averaged in. Every consumer folds
   * over `PRODUCT_DIMENSIONS`; if polish were ever added here it would silently start counting.
   */
  it("do not include the holistic read", () => {
    expect(PRODUCT_DIMENSIONS).not.toContain(POLISH);
  });

  it("describe every dimension for the rubric and the report", () => {
    for (const dimension of PRODUCT_DIMENSIONS) {
      expect(DIMENSION_SUMMARIES[dimension].length).toBeGreaterThan(0);
    }
  });

  /**
   * Naming a dimension after an icon set would compile our taste into the rubric and make the
   * benchmark measure adherence to it rather than whether the product is good. Icon usage is
   * judged under `restraint`, alongside every other decoration that has to earn its place.
   */
  it("name no component library, icon set or framework", () => {
    const vocabulary = [...PRODUCT_DIMENSIONS, ...Object.values(DIMENSION_SUMMARIES)]
      .join(" ")
      .toLowerCase();

    for (const forbidden of ["lucide", "shadcn", "tailwind", "react", "radix", "material"]) {
      expect(vocabulary).not.toContain(forbidden);
    }
  });
});
