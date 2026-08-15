/**
 * Visual quality: the interface, the artefacts it will read, and none of the judge.
 *
 * The specification puts automated visual judgement out of scope — no vision model, no pixel or
 * perceptual similarity, no reference-image comparison — while requiring that the seam exist so
 * one can be added later without reshaping the result model. So this file is a port with two
 * trivial implementations, and that is the whole of it.
 *
 * **Not run is an answer, and it is the default one.** It is not a zero: `docs/adr/0002` has an
 * absent category renormalise out of the weighting, so a run nobody judged visually is scored
 * over the categories that *were* measured rather than being docked fifteen points for a judge
 * that does not exist. Scoring it zero would make every run today cap at 85, which would say
 * something false about the agent.
 *
 * **Provider-agnostic by having no provider-shaped fields.** A result is a status, a number and
 * a `source` string naming whoever produced it. A pixel comparison, a VLM judge and a person
 * looking at a screenshot all fit that without adding a field, because none of what
 * distinguishes them — a threshold, a model id, a prompt — belongs in the *result*. What does
 * belong is attribution: a bare 72 in a report read months later, which could equally have come
 * from a person or a model, is not something anybody can act on.
 *
 * **Never the primary measure.** That is not enforced here; it is a property of the weighting
 * in `category.ts`, where visual is 15 against functional's 50, and of the build and preview
 * gates, which cap or fail a run before any of this is consulted. A broken application must not
 * be rescuable by something thinking it looks nice, and the gate ladder is what makes that true
 * — not anything in this file.
 */

import type { Result } from "@nap/shared/result";
import { z } from "zod";
import { describeParseFailure } from "./parse-failure.ts";
import type { ScreenshotRef } from "./screenshot.ts";

export const VisualEvaluationSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("not_run"),
    /**
     * Why nobody judged it.
     *
     * Required, because "the visual category is missing from this report" and "the visual
     * category was deliberately not evaluated" look identical in an archive otherwise, and only
     * the second is a fact about the benchmark rather than about the file.
     */
    reason: z.string().min(1),
  }),
  z.strictObject({
    status: z.literal("scored"),
    score: z.number().int().min(0).max(100),
    /**
     * Who produced the number — `manual:<somebody>` today, a judge's name later.
     *
     * A free string rather than an enum on purpose: an enum would have to be widened by the
     * pure core every time somebody plugs in a new judge, which is exactly the reshaping this
     * interface exists to avoid.
     */
    source: z.string().min(1),
    /** Why that number, for a score a person assigned and cannot otherwise justify later. */
    notes: z.string().optional(),
  }),
]);

export type VisualEvaluationResult = z.infer<typeof VisualEvaluationSchema>;

/** The default answer, and the one every run gives until a judge is built. */
export const VISUAL_NOT_RUN: VisualEvaluationResult = {
  status: "not_run",
  reason: "no visual judge is configured",
};

/**
 * What a judge is shown.
 *
 * Screenshot *references* rather than bytes: they are already on disk by the time this is asked,
 * a suite's worth of PNGs held in memory for a judge that returns `not_run` would be paid for by
 * every run, and a later judge that wants the pixels can read the path it was handed.
 */
export type VisualEvaluationInput = {
  taskId: string;
  runId: string;
  screenshots: readonly ScreenshotRef[];
};

export interface VisualEvaluation {
  evaluate(input: VisualEvaluationInput): Promise<VisualEvaluationResult>;
}

/** The default: there is no judge, and saying so is the honest result. */
export function notRunVisualEvaluation(): VisualEvaluation {
  return { evaluate: async () => VISUAL_NOT_RUN };
}

/**
 * A score somebody looked at the screenshots and assigned.
 *
 * Validated at construction rather than at use, for the same reason `defineTask` is: the caller
 * is composing a run, and discovering that 120 is not a score *after* the model has been paid
 * is the expensive way to find out.
 */
export function manualVisualEvaluation(judgement: {
  score: number;
  source: string;
  notes?: string;
}): VisualEvaluation {
  const parsed = VisualEvaluationSchema.safeParse({ status: "scored", ...judgement });
  if (!parsed.success) {
    throw new Error(`invalid manual visual evaluation: ${parsed.error.issues[0]?.message}`);
  }

  const result = parsed.data;
  return { evaluate: async () => result };
}

/**
 * The number a run's scoring should use, or nothing.
 *
 * `undefined` rather than `null` because it feeds an optional argument to `scoreRun`, where the
 * absence has to mean "do not add this category at all" — which is the renormalisation, not a
 * zero.
 */
export function visualScoreOf(result: VisualEvaluationResult): number | undefined {
  return result.status === "scored" ? result.score : undefined;
}

export function parseVisualEvaluation(input: unknown): Result<VisualEvaluationResult, string> {
  const parsed = VisualEvaluationSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };

  return { ok: false, error: describeParseFailure(parsed.error, "visual") };
}
