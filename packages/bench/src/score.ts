/**
 * Turning check results into a number that can be explained.
 *
 * A fold over the categories that produced results rather than a fixed four-term expression,
 * because the set of categories present varies per run — see docs/adr/0002. Every figure here
 * decomposes: a category's score is recomputable from its checks, and the overall from the
 * category scores and the configured weights.
 *
 * **Absent is not failed, and the difference is load-bearing.** A category nobody scored into
 * is dropped and its weight redistributed; a category that was asked and did not deliver
 * scores zero and keeps its weight. If those were the same thing, an application that never
 * started would have the browser category's share handed to the categories that did run, and
 * failing to start would *raise* the score. ADR-0002 calls this the sharp edge, and the tests
 * for it exist to pin exactly this case.
 */

import { CATEGORIES, type Category, type CategoryWeights } from "./category.ts";
// Inferred from the schema that persists it rather than restated here, so the shape this
// produces and the shape a report is validated against cannot drift apart.
import type { CategoryScore, CheckResult } from "./report.ts";

export type RunScore = {
  /** Null when nothing produced a result, which is not the same as scoring zero. */
  overall: number | null;
  /** Only the categories that produced results, in canonical order. */
  categories: CategoryScore[];
};

/** A check that was neither passed nor failed produced no observation to score. */
function producedResult(result: CheckResult): boolean {
  return result.outcome === "passed" || result.outcome === "failed";
}

/**
 * Scores a run's checks, optionally with a visual judgement that came from outside them.
 *
 * **`visualScore` is `undefined`, not zero, when nobody judged.** That is the renormalisation:
 * an unevaluated visual category is dropped and its 15% redistributed, so a run today can still
 * reach 100 rather than capping at 85 for a judge that does not exist. Scoring it zero was
 * considered and rejected in docs/adr/0002.
 *
 * The visual category is the one that can be present without checks, because it is the one
 * measured by looking rather than by asserting — which is why `CategoryScore.checks` may be 0
 * for it alone.
 */
export function scoreRun(
  results: readonly CheckResult[],
  weights: CategoryWeights,
  visualScore?: number | undefined,
): RunScore {
  const scored = results.filter(producedResult);
  const hasVisual = visualScore !== undefined;

  const present = CATEGORIES.map((category) => ({
    category,
    checks: scored.filter((result) => result.category === category),
  })).filter((entry) => entry.checks.length > 0 || (entry.category === "visual" && hasVisual));

  if (present.length === 0) return { overall: null, categories: [] };

  // Rescaled over the categories that are actually here, so the overall stays on the same
  // 0–100 scale as a run where every category was present.
  const totalWeight = present.reduce((sum, entry) => sum + weights[entry.category], 0);

  // Every configured weight can legitimately be zero for the categories that turned up,
  // and dividing by that would produce NaN. Falling back to an equal share keeps the run
  // scoreable and is the only reading of "none of these matter" that yields a number.
  const share = (category: Category): number =>
    totalWeight === 0 ? 1 / present.length : weights[category] / totalWeight;

  // Apportioned so the recorded weights sum to exactly 100 — see `apportion`. The overall is
  // then computed from those recorded numbers rather than from the exact shares, which is
  // what makes a report internally consistent: anybody can recompute the score from the
  // figures printed in front of them and get the same answer.
  const effectiveWeights = apportion(
    present.map((entry) => share(entry.category)),
    1,
  );

  const categories: CategoryScore[] = present.map((entry, index) => ({
    category: entry.category,
    // A supplied visual score is the visual category's, even where checks also scored into it.
    // Both at once is a configuration nothing produces today; if it arises, the judge looked at
    // the rendered result while a check measured one property of it, and `checks` below still
    // records that the checks were there.
    score: entry.category === "visual" && hasVisual ? visualScore : scoreCategory(entry.checks),
    effectiveWeight: effectiveWeights[index] ?? 0,
    checks: entry.checks.length,
  }));

  const overall = categories.reduce(
    (sum, entry) => sum + (entry.score * entry.effectiveWeight) / 100,
    0,
  );

  return { overall: Math.round(overall), categories };
}

/**
 * Rounds shares to percentages that still sum to exactly 100.
 *
 * Rounding each share independently does not: three equal categories give 33.3 three times
 * and lose 0.1, while 55.6 + 27.8 + 16.7 gains one. That matters twice over — a reader
 * recomputing the overall from the report would disagree with it, and docs/adr/0002 has
 * `compare` refuse two runs whose effective vectors differ, which would otherwise turn into a
 * comparison of rounding artefacts.
 *
 * Largest remainder: floor everything, then hand the shortfall out to whichever entries were
 * cut by most. Ties go to the earlier entry, so the result depends only on the input.
 */
function apportion(shares: readonly number[], places: number): number[] {
  const factor = 10 ** places;
  const target = 100 * factor;

  const exact = shares.map((share) => share * target);
  const floors = exact.map(Math.floor);
  const shortfall = target - floors.reduce((sum, value) => sum + value, 0);

  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  const result = [...floors];
  for (let given = 0; given < shortfall; given++) {
    const entry = order[given % order.length];
    if (entry !== undefined) result[entry.index] = (result[entry.index] ?? 0) + 1;
  }

  return result.map((value) => value / factor);
}

/** The weighted proportion of a category's checks that passed, as a whole number. */
function scoreCategory(checks: readonly CheckResult[]): number {
  const total = checks.reduce((sum, check) => sum + check.weight, 0);
  // Equal shares when every check in the category is weightless: the alternative is NaN.
  if (total === 0) {
    const passed = checks.filter((check) => check.outcome === "passed").length;
    return Math.round((passed / checks.length) * 100);
  }

  const passed = checks
    .filter((check) => check.outcome === "passed")
    .reduce((sum, check) => sum + check.weight, 0);

  return Math.round((passed / total) * 100);
}
