/**
 * What a judge produces, and what the scorer consumes. Nothing in here knows a judge exists.
 *
 * **This is the seam.** A scripted judge in a unit test, a vision model behind a paid flag and a
 * person filling in a form all produce exactly this shape, which is what lets the free path and
 * the paid path exercise the same scoring code rather than two implementations that agree until
 * they do not. Nothing provider-shaped appears below — no model id field, no prompt, no
 * threshold, no image encoding — because none of that distinguishes one judgement from another
 * once it has been made. What *is* recorded is attribution: a bare set of grades read months
 * later, which could equally have come from a person or a model, is not something anybody can
 * act on.
 *
 * **A grade must be evidenced.** The schema refuses a graded dimension with no evidence, and
 * every piece of evidence names the screenshot it came from. That is the difference between a
 * report a reviewer can check and a number they have to trust: "typography: weak" is an opinion,
 * and "typography: weak, because on `home@mobile` the heading and body differ only in weight"
 * is an argument. It is enforced here rather than asked for in a prompt, because a prompt is a
 * request and a schema is a refusal.
 *
 * **`not_assessable` is absence, not a bad grade.** It means the judge had nothing to look at,
 * which is a fact about the run's circumstances rather than about the application — the same
 * distinction `docs/adr/0002` draws between an absent category and a failed one, and it
 * renormalises for the same reason. A judge that could not see a surface must not be able to
 * lower a score by saying so.
 */

import type { Result } from "@nap/shared/result";
import { z } from "zod";
import { describeParseFailure } from "../parse-failure.ts";
import { ResultsRelativePathSchema } from "../screenshot.ts";
import { ViewportNameSchema } from "../viewport.ts";
import { POLISH, PRODUCT_DIMENSIONS, type ProductDimension } from "./dimension.ts";
import { ConfidenceSchema, GradeSchema } from "./grade.ts";

/**
 * One observation, tied to the image it was made from.
 *
 * The viewport travels with the path even though the path implies it, because the interesting
 * case for `responsiveness` is evidence drawn from two sizes of the same surface, and a reader
 * comparing them should not have to decode filenames to tell which is which.
 */
export const ProductEvidenceSchema = z.strictObject({
  /** The surface this was seen on, as the task named it. */
  surfaceId: z.string().min(1),
  viewport: ViewportNameSchema,
  /** The image, relative to the results directory. */
  screenshot: ResultsRelativePathSchema,
  /** What was seen. A description of the artefact, not a verdict on it. */
  observation: z.string().min(1),
});

export type ProductEvidence = z.infer<typeof ProductEvidenceSchema>;

/**
 * One dimension's answer: a grade with its argument, or an honest refusal to grade.
 *
 * A discriminated union rather than an optional grade, so there is no representable state in
 * which something carries both a grade and a reason it could not be graded.
 */
export const DimensionJudgementSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("graded"),
    grade: GradeSchema,
    /**
     * At least one, always. See this file's header: an unevidenced grade is an opinion, and the
     * report exists so that a reviewer never has to take one on trust.
     */
    evidence: z.array(ProductEvidenceSchema).min(1),
    strengths: z.array(z.string().min(1)),
    weaknesses: z.array(z.string().min(1)),
    /**
     * Optional because a judge that cannot report its own confidence should say nothing rather
     * than default to `medium`, which would be a measurement invented on its behalf.
     */
    confidence: ConfidenceSchema.optional(),
  }),
  z.strictObject({
    status: z.literal("not_assessable"),
    /**
     * Required, because "this dimension is missing from the report" and "the judge looked and
     * had nothing to go on" are indistinguishable otherwise, and only the second is a fact.
     */
    reason: z.string().min(1),
  }),
]);

export type DimensionJudgement = z.infer<typeof DimensionJudgementSchema>;

/**
 * Who graded, and against which rubric.
 *
 * The rubric version is here rather than alongside the run's configuration because it is what
 * makes two judgements comparable: the same model against a reworded rubric is a different
 * instrument, and a score taken under one is not a score taken under the other.
 *
 * `source` is a free string — `manual:<somebody>`, or a model id once one is pinned — rather
 * than an enum, because an enum would have to be widened by this package every time somebody
 * plugs in a new judge, which is exactly the coupling this interface exists to avoid.
 */
export const JudgeIdentitySchema = z.strictObject({
  source: z.string().min(1),
  rubricVersion: z.string().min(1),
});

export type JudgeIdentity = z.infer<typeof JudgeIdentitySchema>;

/**
 * Every dimension, answered.
 *
 * A full record rather than a partial one: a judge that skipped a dimension must have to say
 * `not_assessable` and why, because a silently missing dimension shrinks the product half
 * without anybody noticing, and a shrinking denominator raises the score.
 */
const DimensionJudgementsSchema = z.strictObject(
  Object.fromEntries(
    PRODUCT_DIMENSIONS.map((dimension) => [dimension, DimensionJudgementSchema]),
  ) as Record<ProductDimension, typeof DimensionJudgementSchema>,
);

export const ProductJudgementSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("not_run"),
    /** Why nobody judged. The default answer on every free run, and an honest one. */
    reason: z.string().min(1),
  }),
  z.strictObject({
    status: z.literal("judged"),
    judge: JudgeIdentitySchema,
    dimensions: DimensionJudgementsSchema,
    /**
     * The holistic read, kept beside the dimensions and outside them.
     *
     * Structurally outside rather than excluded by a rule in the scorer: `scoreProduct` folds
     * over `PRODUCT_DIMENSIONS`, and this is not in that list, so it cannot be averaged in by
     * anybody who forgets that it should not be. See `dimension.ts`.
     */
    polish: DimensionJudgementSchema,
  }),
]);

export type ProductJudgement = z.infer<typeof ProductJudgementSchema>;

/** The default answer, and the one every run gives until a judge is composed in. */
export const PRODUCT_NOT_RUN: ProductJudgement = {
  status: "not_run",
  reason: "no product judge is configured",
};

/** The name the holistic read is reported under, so formatters need not hard-code it. */
export const POLISH_LABEL = POLISH;

export function parseProductJudgement(input: unknown): Result<ProductJudgement, string> {
  const parsed = ProductJudgementSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };

  return { ok: false, error: describeParseFailure(parsed.error, "product judgement") };
}
