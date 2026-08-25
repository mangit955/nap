/**
 * Folding a judgement into the product half's number, and combining that half with the
 * objective one.
 *
 * **The two halves multiply rather than add, and this is the central decision of the whole
 * scheme.** Under a weighted mean, an application that does exactly what was asked and looks
 * terrible still scores in the eighties, because correctness carries most of the weight and
 * buys the rest. That is the wrong answer: nobody shipping to a real user would call it a good
 * result. A geometric mean makes neither half able to carry the other — a zero anywhere is a
 * zero overall, and a weak half drags a strong one down towards it rather than being averaged
 * away.
 *
 *     correct 95, beautiful 90  →  √(95 × 90) = 92
 *     correct 95, ugly      25  →  √(95 × 25) = 49
 *     broken  30, beautiful 90  →  √(30 × 90) = 52, and then capped by the build gate
 *     broken  30, ugly      25  →  √(30 × 25) = 27
 *
 * The mirror case was already handled before this existed: the gate ladder fails a run whose
 * preview never served and caps one whose build failed at 40, so a beautiful application that
 * does not work could never score well. What was missing was the other direction, and that is
 * what this supplies.
 *
 * **An unjudged run is scored on the objective half alone**, not on a product half of zero. A
 * free run has no judge, and the entire archive predates this file; scoring their absent half at
 * zero would retroactively halve every number ever recorded and would say something false about
 * every one of them. Absence renormalises, exactly as `docs/adr/0002` has it do for a category.
 */

import { PRODUCT_DIMENSIONS, type ProductDimension } from "./dimension.ts";
import { anchorFor, type Grade } from "./grade.ts";
import type { ProductJudgement } from "./judgement.ts";

/** One dimension's contribution, kept so a reader can recompute the mean from the report. */
export type DimensionScore = {
  dimension: ProductDimension;
  grade: Grade;
  score: number;
};

export type ProductScore = {
  /** The equally-weighted mean of the dimensions that were assessed, 0–100. */
  score: number;
  /** In canonical order, and only the assessed ones. */
  dimensions: DimensionScore[];
  /** How many of the nine produced a grade. Below this, a score is thin evidence. */
  assessed: number;
};

/**
 * The product half's number, or nothing at all.
 *
 * `undefined` rather than `null` or `0`, because it feeds the optional half of
 * `combineHalves`, where absence has to mean "score the objective half alone" — which is the
 * renormalisation, not a zero. Returning `0` here is the single mistake that would make this
 * whole scheme dishonest, so there is no code path that can.
 *
 * Nothing comes back when the judge did not run, and also when it ran and found every dimension
 * unassessable — a judgement with no assessable dimension has measured nothing, and a mean over
 * an empty set is not a low score, it is an absence.
 */
export function scoreProduct(judgement: ProductJudgement): ProductScore | undefined {
  if (judgement.status === "not_run") return undefined;

  const dimensions: DimensionScore[] = [];

  // A fold over the canonical list rather than over the object's own keys, so the order is the
  // one in `dimension.ts` and two reports of the same task cannot differ by arrangement. It is
  // also why `polish` cannot leak in: it is not in this list.
  for (const dimension of PRODUCT_DIMENSIONS) {
    const result = judgement.dimensions[dimension];
    if (result.status !== "graded") continue;

    dimensions.push({ dimension, grade: result.grade, score: anchorFor(result.grade) });
  }

  if (dimensions.length === 0) return undefined;

  const total = dimensions.reduce((sum, entry) => sum + entry.score, 0);

  return {
    score: Math.round(total / dimensions.length),
    dimensions,
    assessed: dimensions.length,
  };
}

/**
 * The overall score for a run measured on both halves.
 *
 * `objective` is what the checks summed to; `product` is absent on any run nobody judged. The
 * result is on the same 0–100 scale as every other score in a report, so a reader does not have
 * to know which scoring model produced a number in order to read it — though `compare` still
 * refuses to put the two models' numbers side by side, because equal scale is not equal meaning.
 */
export function combineHalves(objective: number, product: number | undefined): number {
  if (product === undefined) return Math.round(objective);

  return Math.round(Math.sqrt(objective * product));
}
