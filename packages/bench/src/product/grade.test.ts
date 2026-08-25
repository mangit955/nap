import { describe, expect, it } from "vitest";
import { anchorFor, GRADE_ANCHORS, GRADES, gradeNearest } from "./grade.ts";

describe("the grade scale", () => {
  it("is ordered best to worst", () => {
    expect([...GRADES]).toEqual(["excellent", "good", "moderate", "weak", "poor"]);
  });

  it("anchors every grade, strictly decreasing", () => {
    const anchors = GRADES.map(anchorFor);

    expect(anchors).toHaveLength(GRADES.length);
    for (let index = 1; index < anchors.length; index++) {
      expect(anchors[index]).toBeLessThan(anchors[index - 1] ?? Number.POSITIVE_INFINITY);
    }
  });

  it("keeps every anchor inside the scale a report is read on", () => {
    for (const grade of GRADES) {
      expect(GRADE_ANCHORS[grade]).toBeGreaterThanOrEqual(0);
      expect(GRADE_ANCHORS[grade]).toBeLessThanOrEqual(100);
    }
  });

  /**
   * The floor is what stops one bad dimension swamping eight good ones. If `poor` were 0, a
   * single unassessable-turned-poor grade would drag a nine-dimension mean down by eleven
   * points on its own, and the objective half's gates — not this scale — are what exist to
   * punish an application that does nothing at all.
   */
  it("does not put the worst grade at zero", () => {
    expect(GRADE_ANCHORS.poor).toBeGreaterThan(0);
  });

  /** Nothing rendered is beyond criticism, so the top of the scale leaves room above it. */
  it("does not put the best grade at a hundred", () => {
    expect(GRADE_ANCHORS.excellent).toBeLessThan(100);
  });

  it("names the grade an anchored score came from", () => {
    for (const grade of GRADES) {
      expect(gradeNearest(GRADE_ANCHORS[grade])).toBe(grade);
    }
  });

  it("names the nearest grade for a mean that lands between anchors", () => {
    // Between `weak` (35) and `moderate` (55), closer to moderate.
    expect(gradeNearest(50)).toBe("moderate");
    expect(gradeNearest(38)).toBe("weak");
  });
});
