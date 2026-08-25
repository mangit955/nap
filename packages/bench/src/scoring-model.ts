/**
 * Which arithmetic produced a run's score, and why two of them may never be compared.
 *
 * `v1` is the weighted mean over four categories — functional, browser, visual, code —
 * renormalised across whichever produced results. Every funded run in `docs/napbench-*.md` was
 * taken under it, and it is frozen along with the `all` suite it was taken on.
 *
 * `v2` splits a run into an objective half scored from checks and a product half graded by a
 * judge, and combines them geometrically. The scale is the same 0–100; the meaning is not. An 85
 * under `v1` is "the checks mostly passed and nobody looked at it"; an 85 under `v2` is "the
 * checks mostly passed *and* somebody looked at it and thought it was good". Putting those two
 * numbers side by side would suggest a comparison that has not been made.
 *
 * **So `compare` refuses across models**, for the same reason it already refuses two runs with
 * differing effective weight vectors and two runs held at different turn budgets: a number is
 * only meaningful relative to what it was a mean of. This is a refusal rather than a warning
 * because, unlike a differing harness identity, nobody has a question that a v1-versus-v2
 * comparison would answer — the two measure different things on purpose.
 *
 * A report with no recorded model is `v1`. That is not a guess: `v2` did not exist when those
 * reports were written, so the absence is itself the evidence, and defaulting keeps the whole
 * archive parseable rather than stranding it behind a field it could not have carried.
 */

import { z } from "zod";

export const SCORING_MODELS = ["v1", "v2"] as const;

export const ScoringModelSchema = z.enum(SCORING_MODELS);
export type ScoringModel = z.infer<typeof ScoringModelSchema>;

/** The four-category weighted mean. Frozen, and what the `all` suite is scored under. */
export const SCORING_MODEL_V1: ScoringModel = "v1";

/** Objective and product halves, combined geometrically. */
export const SCORING_MODEL_V2: ScoringModel = "v2";

/**
 * What a report that does not say should be read as. See this file's header.
 *
 * Deliberately not applied by a schema `.default()`: a default would make a report that was
 * *written* as v1 and one that predates the field indistinguishable on the way back out, and
 * only the reader needs them collapsed — the file should keep saying what it actually said.
 */
export function scoringModelOf(recorded: ScoringModel | undefined): ScoringModel {
  return recorded ?? SCORING_MODEL_V1;
}
