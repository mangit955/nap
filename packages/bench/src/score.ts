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
import type { CheckResult } from "./report.ts";

export type CategoryScore = {
  category: Category;
  /** 0–100: the weighted proportion of this category's checks that passed. */
  score: number;
  /**
   * This category's share of the overall score, after dropping absent categories and
   * rescaling. Rounded to one decimal for reading; the overall is computed from the
   * configured vector exactly.
   */
  effectiveWeight: number;
  /** How many checks produced a result here — absent ones are not counted. */
  checks: number;
};

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

export function scoreRun(results: readonly CheckResult[], weights: CategoryWeights): RunScore {
  const scored = results.filter(producedResult);

  const present = CATEGORIES.map((category) => ({
    category,
    checks: scored.filter((result) => result.category === category),
  })).filter((entry) => entry.checks.length > 0);

  if (present.length === 0) return { overall: null, categories: [] };

  // Rescaled over the categories that are actually here, so the overall stays on the same
  // 0–100 scale as a run where every category was present.
  const totalWeight = present.reduce((sum, entry) => sum + weights[entry.category], 0);

  // Every configured weight can legitimately be zero for the categories that turned up,
  // and dividing by that would produce NaN. Falling back to an equal share keeps the run
  // scoreable and is the only reading of "none of these matter" that yields a number.
  const share = (category: Category): number =>
    totalWeight === 0 ? 1 / present.length : weights[category] / totalWeight;

  const categories: CategoryScore[] = present.map((entry) => ({
    category: entry.category,
    score: scoreCategory(entry.checks),
    effectiveWeight: round(share(entry.category) * 100, 1),
    checks: entry.checks.length,
  }));

  const overall = categories.reduce((sum, entry) => sum + entry.score * share(entry.category), 0);

  return { overall: Math.round(overall), categories };
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

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
