/**
 * What a run produces: a stable, machine-readable record of what happened and what it scored.
 *
 * Reports are archived, diffed and compared across months, so the shape is validated on the
 * way *in* as well as on the way out — a report read back from disk is untrusted input, and a
 * comparison against a malformed one would be worse than a refusal.
 *
 * **Three ids, deliberately spelled out.** `CONTEXT.md` names this as the collision to guard:
 * a NapBench *run* contains a Nap *session*, which contains one or more *turns*. A field
 * called `id` would make a report ambiguous forever, so there is no such field.
 *
 * **`null` rather than absent** for a score and a turn that do not exist. The repository
 * learned this from persisted event payloads: `undefined` disappears through JSON, so a
 * missing value and an omitted key become the same thing, and "this run has no score" stops
 * being distinguishable from "this report is from an older shape".
 */

import type { Result } from "@nap/shared/result";
import { z } from "zod";

export const CheckResultSchema = z.strictObject({
  checkId: z.string().min(1),
  kind: z.literal("command"),
  passed: z.boolean(),
  /** Why, in a few words — the exit code, or what stopped it running at all. */
  detail: z.string(),
});

/**
 * How a run ended.
 *
 * *Passed* and *failed* are results and carry a score. *Errored* means no result was obtained,
 * so there is nothing to score — an agent that crashed and an agent that built something
 * broken are different findings, and a zero would merge them.
 *
 * CONTEXT.md names a fourth, *cancelled*, which is not accepted yet because nothing can
 * cancel a run. It will join *errored* on the unscored side rather than the scored one: a
 * run somebody stopped is not an observation either.
 */
export const RunStatusSchema = z.enum(["passed", "failed", "errored"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** The statuses that are results, and therefore the ones that carry a score. */
const SCORED_STATUSES: readonly RunStatus[] = ["passed", "failed"];

export const BenchReportSchema = z
  .strictObject({
    /** This run. Not the session, and not a turn. */
    runId: z.uuid(),
    taskId: z.string().min(1),
    /** The Nap session the run drove. */
    sessionId: z.uuid(),
    /** Null when no turn was ever started, or the turn id is unknown. */
    turnId: z.uuid().nullable(),
    status: RunStatusSchema,
    /** 0–100, or null when the run errored and produced no observation. */
    score: z.number().int().min(0).max(100).nullable(),
    checks: z.array(CheckResultSchema),
  })
  .refine((report) => SCORED_STATUSES.includes(report.status) === (report.score !== null), {
    // The two must agree in both directions. A scored error is a fabricated number, and an
    // unscored pass is a result nobody can read. Written against the set of statuses that
    // carry a result rather than against "errored", so that adding cancellation is one entry
    // here rather than an inverted condition.
    message: "a score is present exactly when the run produced a result",
    path: ["score"],
  });

export type CheckResult = z.infer<typeof CheckResultSchema>;
export type BenchReport = z.infer<typeof BenchReportSchema>;

/** Indented, because a committed report is read and diffed by people. */
export function serialiseBenchReport(report: BenchReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function parseBenchReport(input: unknown): Result<BenchReport, string> {
  const parsed = BenchReportSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };

  return {
    ok: false,
    error: parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "report"}: ${issue.message}`)
      .join("; "),
  };
}
