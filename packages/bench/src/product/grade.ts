/**
 * The five-point scale a product dimension is graded on, and the numbers those grades stand for.
 *
 * **Ordinal, not numeric, and that is the whole point.** A judge asked for `73` invents precision
 * it does not have: the same screenshots graded twice come back 68 and 79, and the difference is
 * noise that a reader cannot distinguish from a real movement. Asked instead whether the
 * typography is `weak` or `moderate`, it is making a judgement a person can check against the
 * evidence it cited. The anchors below turn that judgement into arithmetic *afterwards*, in our
 * code, where the mapping is fixed and inspectable rather than re-improvised per run.
 *
 * The anchors are deliberately not evenly spaced. `excellent` sits at 95 rather than 100 because
 * nothing rendered is beyond criticism, and `poor` at 12 rather than 0 because a page that draws
 * something is not worth the same as a page that draws nothing — the objective half already has
 * gates for that, and a floor of zero here would let one bad dimension swamp eight good ones.
 *
 * **`not_assessable` is not a sixth grade.** It carries no number at all, because it means the
 * judge had nothing to look at — the surface never rendered, or the dimension does not apply to
 * what was built. That is absence, and absence renormalises rather than scoring low, exactly as
 * it does for a check category in `docs/adr/0002`. It is kept out of `GRADES` so that no
 * exhaustive map over the scale can accidentally give it a value.
 */

import { z } from "zod";

/**
 * Best to worst, and the order matters: comparisons and report formatting both read it from
 * here rather than re-listing it, so a scale that gains a point cannot end up sorted two ways.
 */
export const GRADES = ["excellent", "good", "moderate", "weak", "poor"] as const;

export const GradeSchema = z.enum(GRADES);
export type Grade = z.infer<typeof GradeSchema>;

/**
 * What each grade is worth, on the same 0–100 scale as every other score in a report.
 *
 * `satisfies` rather than an annotation so that adding a grade without an anchor fails to
 * compile, which is the only way this stays exhaustive.
 */
export const GRADE_ANCHORS = {
  excellent: 95,
  good: 78,
  moderate: 55,
  weak: 35,
  poor: 12,
} as const satisfies Record<Grade, number>;

/** How sure the judge is. Ordinal for the reason the grade is. */
export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

export const ConfidenceSchema = z.enum(CONFIDENCE_LEVELS);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export function anchorFor(grade: Grade): number {
  return GRADE_ANCHORS[grade];
}

/**
 * The grade an anchored number came from, for reading a score back out in prose.
 *
 * Nearest anchor rather than exact match: a dimension mean is an average of anchors and lands
 * between them, and a reader wants "roughly moderate" rather than nothing. Ties go to the
 * better grade, which only arises at exact midpoints between two anchors.
 */
export function gradeNearest(score: number): Grade {
  let nearest: Grade = GRADES[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const grade of GRADES) {
    const distance = Math.abs(GRADE_ANCHORS[grade] - score);
    if (distance < bestDistance) {
      nearest = grade;
      bestDistance = distance;
    }
  }

  return nearest;
}
