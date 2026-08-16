/**
 * What running one check produced.
 *
 * Three values, not a boolean, and the third is the one that matters. *Absent* means nobody
 * asked — there is no `lint` script, or an earlier failure stopped the run before this one —
 * while *failed* means it was asked and did not get what it wanted.
 *
 * The gap is load-bearing on both sides of this package, in different ways. NapBench
 * renormalises an absent category out of its weighting rather than scoring it zero, so an
 * unasked question cannot be counted against the agent (docs/adr/0002). The runtime's verifier
 * needs it for a plainer reason: a fresh project with no test script has not failed its tests,
 * and treating a missing script as a failure would open a repair loop that no amount of
 * repairing can close.
 *
 * Two consumers arrived at the same three answers independently, which is why the type lives
 * here rather than in either of them. See docs/adr/0007.
 */

import { z } from "zod";

export const CheckOutcomeSchema = z.enum(["passed", "failed", "absent"]);
export type CheckOutcome = z.infer<typeof CheckOutcomeSchema>;

/**
 * Whether this outcome is evidence about the code, as opposed to a record that nothing was
 * looked at.
 *
 * Named for what it asks rather than as `!== "absent"`, because the negation is the thing
 * callers get wrong: both places that count outcomes want "how many checks actually told us
 * something", and writing that as a not-equals at each site is how a third value quietly
 * becomes a boolean again.
 */
export function isObservation(outcome: CheckOutcome): boolean {
  return outcome !== "absent";
}
