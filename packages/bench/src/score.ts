/**
 * Turning check results into a number.
 *
 * One category and no weights, deliberately: this is the thin version, and the weighted,
 * renormalising engine that ADR-0002 describes replaces it wholesale. What must survive that
 * replacement is the property this already has — every score decomposes into the checks that
 * produced it, so a number can always be explained by pointing at a list.
 */

import type { CheckResult } from "./report.ts";

/** The percentage of checks that passed, rounded to a whole number. */
export function scoreChecks(results: readonly CheckResult[]): number {
  // No checks is zero rather than NaN or 100: "everything asked of it passed" is the wrong
  // reading of a run that was asked nothing.
  if (results.length === 0) return 0;

  const passed = results.filter((result) => result.passed).length;
  return Math.round((passed / results.length) * 100);
}
