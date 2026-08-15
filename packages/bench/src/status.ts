/**
 * How a run ended, and what each ending is allowed to be used for.
 *
 * Four answers, and the distinctions between them are the ones that keep the benchmark
 * honest. *Passed* and *failed* are results and carry a score. *Errored* means no result was
 * obtained — an agent that crashed and an agent that built something broken are different
 * findings, and a zero would merge them. *Cancelled* means somebody stopped the run, which is
 * not an observation about anything.
 *
 * The two predicates here exist because "carries a score" and "counts towards the suite's
 * numbers" are not the same question, and answering them with one flag is how a cancelled run
 * ends up inflating an error rate. See the vocabulary in `CONTEXT.md`.
 */

import { z } from "zod";

export const RUN_STATUSES = ["passed", "failed", "errored", "cancelled"] as const;

export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** The statuses that are results, and therefore the ones that carry a score. */
export const SCORED_STATUSES = ["passed", "failed"] as const satisfies readonly RunStatus[];

/**
 * Whether this ending produced a number.
 *
 * Written as a set membership rather than as `status !== "errored"` so that the two unscored
 * endings stay one concept: a fifth status would be one entry here rather than a condition to
 * invert in every place that asks.
 */
export function carriesScore(status: RunStatus): boolean {
  return (SCORED_STATUSES as readonly RunStatus[]).includes(status);
}

/**
 * Whether a suite may count this run at all — in its numerator *or* its denominator.
 *
 * Errored runs count: a configuration that errors half the time is worse than one that does
 * not, and hiding that would make the error rate the one number nobody could see. Cancelled
 * runs do not, in either direction: counted as errors they blame the agent for an operator's
 * decision, counted as failures they depress a pass rate, and counted at all they let whoever
 * ran the suite change its numbers by pressing stop.
 */
export function countsInAggregates(status: RunStatus): boolean {
  return status !== "cancelled";
}
