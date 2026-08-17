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
 *
 * **The harness is here because Nap stopped holding still.** ADR-0004 fixed the frame as *the
 * model, with Nap held fixed*, and every field above describes the model's side of it. Once Nap
 * itself is the thing being changed, a report that names only the model repeats the same
 * collapse one level up: two runs that look comparable and are not.
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

/**
 * Which Nap produced the run — the harness identity.
 *
 * "Harness" is overloaded in this repo and this is the third meaning: not NapBench, which is the
 * evaluation harness, and not `bun run harness`, which drives one turn. Here it is the system
 * under test, named from the outside. `CONTEXT.md` carries the collision.
 *
 * **The commit, because it is the only identifier that already exists.** A version string would
 * have to be maintained by whoever remembers to, and the run that most needs identifying is the
 * one somebody did in a hurry. A sha is free, exact, and something a reader can check out.
 *
 * **`dirty`, because a sha on a modified tree is not an identity.** It is the difference between
 * "this is the Nap that ran" and "this is roughly the Nap that ran", and a reader comparing two
 * archived runs has no other way to learn which they are holding.
 *
 * **`verification`, because it is what V2 changed.** The loop is the one difference the funded
 * before/after measurement exists to attribute, and an arm that cannot be told from the other
 * arm by reading its report is not an arm.
 */
export const HarnessRecordSchema = z.strictObject({
  /** The commit the run was performed at. `.min(1)` for the same reason `model` has it. */
  commit: z.string().min(1),
  /** Whether that commit's tree had uncommitted changes, which makes the sha approximate. */
  dirty: z.boolean(),
  /** Whether the runtime arbitrated its turns' claims, rather than ending them on the model's word. */
  verification: z.boolean(),
});

export type HarnessRecord = z.infer<typeof HarnessRecordSchema>;

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
  /**
   * Which Nap ran, or null when nobody could say.
   *
   * Defaulted rather than required, which the two fields above are not, and for the reason the
   * report's own `configuration` is: reports written before this existed carry a configuration
   * without it, and they have to keep parsing or the tool loses the ability to read its own
   * archive. Null means *unrecorded* — a run outside a checkout, or one from before V2 — and
   * never "no harness", which is not a thing a report can be produced by.
   */
  harness: HarnessRecordSchema.nullable().default(null),
});

export type RunConfiguration = z.infer<typeof RunConfigurationSchema>;

/**
 * What a run that recorded neither looks like.
 *
 * Also what an archived report parses as. Reports written before the configuration existed are
 * historical records rather than data to migrate, so they read as having declared nothing —
 * which is true, and is distinguishable from having declared something.
 */
export const UNRECORDED_CONFIGURATION: RunConfiguration = {
  model: null,
  budget: null,
  harness: null,
};

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

/**
 * Whether two runs are known to have been produced by different Naps.
 *
 * The same three-answers-into-two collapse as `budgetsDiffer`, and folded the same way: an
 * unknown reads as *same*, because every report written before the harness was recorded has a
 * null one and rounding the other way would make the whole pre-V2 archive incomparable.
 *
 * **`dirty` deliberately does not count as a difference.** It says the sha is approximate rather
 * than that the two runs disagree, and two runs off one modified tree are as likely to be
 * identical as not — which is *cannot tell* again, and gets the same answer. It is still
 * reported, by `describeHarness`, because a reader deciding how much to trust a comparison
 * needs it.
 */
export function harnessesDiffer(
  baseline: HarnessRecord | null,
  candidate: HarnessRecord | null,
): boolean {
  if (baseline === null || candidate === null) return false;

  return baseline.commit !== candidate.commit || baseline.verification !== candidate.verification;
}

/** One readable phrase. For messages only; nothing decides on this string. */
export function describeHarness(harness: HarnessRecord | null): string {
  if (harness === null) return "unrecorded";

  // Short, because a comparison names two of them on one line — the same reason run ids are cut.
  const commit = harness.commit.slice(0, 8);
  const modified = harness.dirty ? " (modified)" : "";
  return `${commit}${modified}, verification ${harness.verification ? "on" : "off"}`;
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
