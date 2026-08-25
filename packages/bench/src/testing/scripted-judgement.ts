/**
 * A judge that decides its grades in advance — the free path's judge, and every test's.
 *
 * **Its grades are meaningless about any application.** They are fixed constants below; they were
 * not arrived at by looking at anything, they do not change when the application does, and no
 * number derived from them says whether a model built something good. That is exactly the caveat
 * a dry run already carries about its score, and it is the same caveat for the same reason: a dry
 * run exercises the machinery rather than a model.
 *
 * **What it is worth is everything downstream of it.** Without a scripted judge, every free run
 * scores objective-only, and the geometric combination, the renormalisation of an absent half and
 * the report's whole product section are untested until somebody pays for a vision model. With
 * one, a run that costs nothing drives the identical code a paid run will: the same schema, the
 * same fold over `PRODUCT_DIMENSIONS`, the same `combineHalves`. The seam is `ProductJudgement`
 * and neither side of it knows which judge it is talking to — see `product/evaluation.ts`.
 *
 * It grades from the screenshots it was handed rather than ignoring them, and that is not
 * decoration: it is what proves the capture pass actually reaches the judge. Every citation names
 * an image the run really took, so a report produced on the free path has the same evidence
 * structure — and the same broken-link failure mode — as one produced on a paid run.
 *
 * Lives in `testing/` beside `ScriptedBrowserSession`, and is composed by the benchmark's own
 * script for the same reason that one is: on a dry run the fakes *are* the composition.
 */

import { POLISH, PRODUCT_DIMENSIONS, type ProductDimension } from "../product/dimension.ts";
import type {
  ProductEvaluation,
  ProductEvaluationInput,
  SurfaceScreenshot,
} from "../product/evaluation.ts";
import type { Grade } from "../product/grade.ts";
import type {
  DimensionJudgement,
  JudgeIdentity,
  ProductEvidence,
  ProductJudgement,
} from "../product/judgement.ts";

/**
 * Who it says graded, and it says so honestly.
 *
 * `source` names the fixture rather than a model, because the field exists so that a report read
 * months later can be told apart from one a judge actually produced — and a scripted run's grades
 * are the ones somebody would most regret mistaking for a measurement. The rubric version says
 * the same thing: nothing was graded against a rubric, so naming one would be a fiction.
 */
export const SCRIPTED_JUDGE: JudgeIdentity = {
  source: "scripted:fixture",
  rubricVersion: "scripted — no rubric was applied",
};

/**
 * The grades it hands out, and they are deliberately not all the same.
 *
 * A uniform judgement would fold to one of the anchors, so a scorer that returned its first
 * dimension instead of the mean would pass every test written against it. This spread means the
 * product half is a number that appears nowhere in `GRADE_ANCHORS`, which is what makes the fold
 * observable. Beyond that the particular grades mean nothing — see this file's header.
 */
export const SCRIPTED_GRADES = {
  hierarchy: "good",
  typography: "moderate",
  spacing: "good",
  color: "moderate",
  layout: "good",
  components: "moderate",
  interaction: "weak",
  responsiveness: "good",
  restraint: "moderate",
  [POLISH]: "moderate",
} as const satisfies Record<ProductDimension | typeof POLISH, Grade>;

/** What a caller may say differently, one dimension at a time. */
export type ScriptedGrades = Partial<Record<ProductDimension | typeof POLISH, Grade>>;

/**
 * A judgement over the images a run actually produced.
 *
 * Every dimension is answered, because a silently missing one shrinks the denominator and a
 * shrinking denominator raises the score. With no images every dimension is `not_assessable`,
 * which is absence rather than a bad grade: the product half then renormalises out and the run is
 * scored on its objective half alone.
 */
export function scriptedJudgement(
  screenshots: readonly SurfaceScreenshot[],
  grades: ScriptedGrades = {},
): ProductJudgement {
  const answer = (dimension: ProductDimension | typeof POLISH): DimensionJudgement =>
    judgeDimension(dimension, screenshots, grades[dimension] ?? SCRIPTED_GRADES[dimension]);

  return {
    status: "judged",
    judge: SCRIPTED_JUDGE,
    dimensions: Object.fromEntries(
      PRODUCT_DIMENSIONS.map((dimension) => [dimension, answer(dimension)]),
    ) as Record<ProductDimension, DimensionJudgement>,
    polish: answer(POLISH),
  };
}

/** The port, so a run can be composed with it exactly as it would be with a real judge. */
export function scriptedProductJudge(grades: ScriptedGrades = {}): ProductEvaluation {
  return {
    evaluate: async (input: ProductEvaluationInput) => scriptedJudgement(input.screenshots, grades),
  };
}

function judgeDimension(
  dimension: ProductDimension | typeof POLISH,
  screenshots: readonly SurfaceScreenshot[],
  grade: Grade,
): DimensionJudgement {
  const evidence = evidenceFor(dimension, screenshots);
  if (evidence.length === 0) {
    return {
      status: "not_assessable",
      reason: "the run photographed no surface, so there was nothing to look at",
    };
  }

  return { status: "graded", grade, evidence, strengths: [], weaknesses: [] };
}

/**
 * Which images a dimension cites.
 *
 * `responsiveness` cites a surface at both sizes, because that is the comparison it is graded on
 * and a report whose responsiveness evidence was one image would be an argument nobody can check.
 * Everything else cites the first image, which is enough to satisfy the schema's rule that no
 * grade travels without the picture it came from.
 */
function evidenceFor(
  dimension: ProductDimension | typeof POLISH,
  screenshots: readonly SurfaceScreenshot[],
): ProductEvidence[] {
  const cited = dimension === "responsiveness" ? pairOf(screenshots) : screenshots.slice(0, 1);

  return cited.map((shot) => ({
    surfaceId: shot.surfaceId,
    viewport: shot.viewport,
    screenshot: shot.path,
    // Stated on every single line of evidence rather than once in a header nobody reads beside
    // the grade: this is the sentence that stops a scripted report being quoted as a finding.
    observation: "a scripted judgement — this grade was fixed in advance and describes no image",
  }));
}

/** One surface at both sizes, or whatever less than that the run managed. */
function pairOf(screenshots: readonly SurfaceScreenshot[]): SurfaceScreenshot[] {
  const first = screenshots[0];
  if (first === undefined) return [];

  const sameSurface = screenshots.filter((shot) => shot.surfaceId === first.surfaceId);
  const other = sameSurface.find((shot) => shot.viewport !== first.viewport);

  return other === undefined ? [first] : [first, other];
}
