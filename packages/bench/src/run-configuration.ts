/**
 * What a run was *held at*, as opposed to what it spent.
 *
 * NapBench measures the model with everything else held fixed (docs/adr/0004), so "everything
 * else" has to be written down somewhere a reader months later can check it. This is that
 * record: which model ran, and the ceilings the turn was given.
 *
 * **Deliberately not the metrics.** `metrics.ts` also names a model, and the two are different
 * facts that happen to share a value: the metric exists to price what a run consumed, and this
 * exists to say what it was configured as. Collapsing them would be tidy right up to the first
 * run whose configuration and consumption disagree — a fallback that switched models mid-run
 * would make one of the two readings wrong, and nobody could say which.
 *
 * **The budget is here because of what it decides.** `budget_exceeded` is attributed to the
 * agent, on the grounds that a model which never converges within a fixed ceiling is exhibiting
 * a real behaviour. That is only honest while the ceiling is genuinely fixed, so two runs held
 * at different ones must not be compared — and a comparison cannot refuse what the report never
 * recorded.
 */

import type { Result } from "@nap/shared/result";
import { z } from "zod";
import { describeParseFailure } from "./parse-failure.ts";

/**
 * The ceilings one turn was given, resolved rather than as they were declared.
 *
 * Resolved on purpose: a run that left `maxSteps` to its default and one that passed the
 * default explicitly were held at the same ceiling, and recording the *declaration* would make
 * those two refuse to compare over a difference that does not exist. Whoever composes the run
 * knows the defaults; the report records the answer.
 *
 * Both ceilings, not just steps, because either can be the one a turn actually hits — and a
 * report that named only the one that was not hit would explain nothing.
 */
export const TurnBudgetRecordSchema = z.strictObject({
  maxSteps: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
});

export type TurnBudgetRecord = z.infer<typeof TurnBudgetRecordSchema>;

export const RunConfigurationSchema = z.strictObject({
  /**
   * Which model ran. Null when the run left it to the deployment's default and never said.
   *
   * `.min(1)` so that an empty string cannot become a second way of saying "unrecorded" — one
   * of the two would not survive a round trip as the thing it was meant to be.
   */
  model: z.string().min(1).nullable(),
  /** Null on a run composed without one, and on every report written before this existed. */
  budget: TurnBudgetRecordSchema.nullable(),
});

export type RunConfiguration = z.infer<typeof RunConfigurationSchema>;

/**
 * What a run that recorded neither looks like.
 *
 * Also what an archived report parses as. Reports written before the configuration existed are
 * historical records rather than data to migrate, so they read as having declared nothing —
 * which is true, and is distinguishable from having declared something.
 */
export const UNRECORDED_CONFIGURATION: RunConfiguration = { model: null, budget: null };

/**
 * Whether two runs were held at ceilings that are known to be different.
 *
 * Three answers collapsed into two, and the collapse is the interesting part: *same*, *known to
 * differ*, and *cannot tell* — with the last folded in with *same* rather than with *differ*.
 *
 * The alternative rounds the wrong way. Every report written before this field existed has a
 * null budget, so answering true for an unknown would make all of them permanently incomparable
 * with everything that came after — refusing on the strength of a fact nobody recorded. The
 * cost of this direction is a comparison that quietly proceeds across an unknown, which is
 * exactly what happened before this existed at all.
 */
export function budgetsDiffer(
  baseline: TurnBudgetRecord | null,
  candidate: TurnBudgetRecord | null,
): boolean {
  if (baseline === null || candidate === null) return false;

  return baseline.maxSteps !== candidate.maxSteps || baseline.maxTokens !== candidate.maxTokens;
}

/** One readable phrase. For messages only; nothing decides on this string. */
export function describeTurnBudget(budget: TurnBudgetRecord | null): string {
  if (budget === null) return "unrecorded";

  return `${budget.maxSteps} steps / ${budget.maxTokens} tokens`;
}

export function parseRunConfiguration(input: unknown): Result<RunConfiguration, string> {
  const parsed = RunConfigurationSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };

  return { ok: false, error: describeParseFailure(parsed.error, "run configuration") };
}
