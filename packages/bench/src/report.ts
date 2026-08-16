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
 *
 * **The exception, and what earns it:** a field that genuinely has no referent on most records
 * is absent instead. A check's captured output is the case — a passing check, a browser check
 * and a silent command all have nothing to say, and writing empty streams onto every one of
 * them would put noise into an artefact people diff. The rule above is about a value that is
 * missing; this is about a field that does not apply.
 */

import type { Result } from "@nap/shared/result";
import { z } from "zod";
import { CategorySchema, type CategoryWeights, CategoryWeightsSchema } from "./category.ts";
import { CommandOutputSchema } from "./command-output.ts";
import { ErrorKindSchema } from "./error-kind.ts";
import { GateIdSchema } from "./gates.ts";
import { type RunMetrics, RunMetricsSchema } from "./metrics.ts";
import { describeParseFailure } from "./parse-failure.ts";
import {
  type RunConfiguration,
  RunConfigurationSchema,
  UNRECORDED_CONFIGURATION,
} from "./run-configuration.ts";
import { ScreenshotRefSchema } from "./screenshot.ts";
import { carriesScore, RunStatusSchema } from "./status.ts";
import { VISUAL_NOT_RUN, VisualEvaluationSchema } from "./visual.ts";

/**
 * What a check produced.
 *
 * Three values, not a boolean, and the third is the one that matters: *absent* means the run
 * never got to ask, which is a property of its circumstances, while *failed* means it asked
 * and did not get what it wanted, which is a property of the agent. Only absent renormalises
 * a category away — see the reasoning in score.ts and docs/adr/0002.
 */
export const CheckOutcomeSchema = z.enum(["passed", "failed", "absent"]);
export type CheckOutcome = z.infer<typeof CheckOutcomeSchema>;

export const CheckResultSchema = z.strictObject({
  checkId: z.string().min(1),
  /** Which kind of check produced this, so a report can be read without its task beside it. */
  kind: z.enum(["command", "browser", "accessibility"]),
  /** Which axis this check scored into, after any override the task declared. */
  category: CategorySchema,
  /** Its worth relative to the other checks in the same category. */
  weight: z.number().nonnegative(),
  /** Whether failing it fails the run outright. Declared here; acted on by the gate ladder. */
  required: z.boolean(),
  /** Whether this is the build, whose failure also caps the run's score. Same arrangement. */
  build: z.boolean(),
  outcome: CheckOutcomeSchema,
  /** Why, in a few words — the exit code, or what stopped it running at all. */
  detail: z.string(),
  /**
   * What the command actually said, on a command check that failed and said something.
   *
   * `detail` gives the exit code; this gives the reason. The distinction was learned from a
   * paid run whose report said `exit 1` while the sentence that explained it — a missing
   * script — sat on a stderr nobody had kept.
   *
   * **Absent rather than null**, unlike the score and the turn id above. Those are fields that
   * always exist and may have no value, so `null` distinguishes "no score" from "old shape".
   * This one genuinely does not exist on most checks: a passing check, a browser check and a
   * silent command all have nothing to record, and writing empty streams on each of them would
   * put noise into every line of a diffed artefact. Same reasoning as the absent metrics in
   * docs/adr/0003.
   */
  output: CommandOutputSchema.optional(),
});

export const CategoryScoreSchema = z.strictObject({
  category: CategorySchema,
  score: z.number().int().min(0).max(100),
  /**
   * This category's share after absent ones were dropped and the rest rescaled.
   *
   * These sum to exactly 100 across a report's categories, which is what lets a reader
   * recompute the weighted mean from the figures in front of them — and what lets two runs'
   * vectors be compared for equality without comparing rounding artefacts. The mean is the
   * overall score unless a gate capped it, in which case `scoreCap` says by how much.
   */
  effectiveWeight: z.number().min(0).max(100),
  checks: z.number().int().nonnegative(),
});

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
    /**
     * Whose fault it was, and null unless the run errored.
     *
     * The only thing an unscored run can contribute to a benchmark, which is why it is a
     * field of its own rather than something to read out of a message.
     */
    errorKind: ErrorKindSchema.nullable(),
    /**
     * Which gates fired, in the order the ladder asked them.
     *
     * A run can fail with a high score — a failing build caps it rather than zeroing it — so
     * without this the report would contain a status its own numbers do not explain.
     */
    gates: z.array(GateIdSchema),
    /**
     * The ceiling a gate put on the score, or null when none did.
     *
     * The report has to stay arithmetically closed: every figure in it is derivable from the
     * others, so that a reader recomputing the headline gets the same answer rather than
     * discovering that some rule they cannot see took ten points off. With this, `score` is
     * exactly `min(weighted mean of the categories, scoreCap)`.
     */
    scoreCap: z.number().int().min(0).max(100).nullable(),
    /** 0–100, or null when the run produced no observation to score. */
    score: z.number().int().min(0).max(100).nullable(),
    /**
     * Per-category scores with the weight each actually carried.
     *
     * Recorded because a score is not interpretable without knowing what it was a weighted
     * mean of — a run scored without the visual category and one scored with it are not on
     * the same scale, and only this makes that visible months later.
     */
    categories: z.array(CategoryScoreSchema),
    /** The configured vector, so the effective one above can be recomputed and checked. */
    weights: CategoryWeightsSchema,
    /**
     * What this run was *held at* — the model, and the turn's ceilings.
     *
     * The one field here that defaults rather than being required, and it is the exception the
     * archive earns: reports written before it existed must still parse, or the tool stops
     * being able to read its own history. It defaults to *unrecorded* rather than to the
     * current defaults, because a plausible-looking budget on a run that never declared one is
     * a fact invented into an artefact people trust.
     *
     * A getter, not a literal: a shared default object would be handed to every archived report
     * parsed in a process, so a single later write would edit all of them at once.
     */
    configuration: RunConfigurationSchema.default(() => ({ ...UNRECORDED_CONFIGURATION })),
    checks: z.array(CheckResultSchema),
    /**
     * How the agent got there, derived from the run's event stream.
     *
     * Present on every report, including errored ones — a run that failed still did things,
     * and what it did before it stopped is often the most informative thing about it. Some
     * of its fields are absent rather than zero; `metrics.ts` says which and why.
     */
    metrics: RunMetricsSchema,
    /**
     * What the run photographed, by path relative to the results directory.
     *
     * Relative on purpose, and it is the same rule that keeps a report from naming its own
     * trajectory: an absolute path baked into an archived artefact is wrong the first time
     * somebody moves the directory. Empty for a run that opened no browser, and also for one
     * whose screenshots could not be written — an image is evidence about a run rather than an
     * observation of the application, so losing one degrades the report and changes no score.
     */
    screenshots: z.array(ScreenshotRefSchema),
    /**
     * What a visual judge made of it, which today is always `not_run`.
     *
     * Recorded even so, rather than omitted while nothing produces it: a reader has to be able
     * to tell "visual was not evaluated" from "this report predates the field", and the whole
     * scale of the run depends on which — an unevaluated visual category renormalises out and
     * puts every other category on a different denominator. See docs/adr/0002.
     */
    visual: VisualEvaluationSchema,
  })
  .refine((report) => carriesScore(report.status) === (report.score !== null), {
    // The two must agree in both directions. A scored error is a fabricated number, and an
    // unscored pass is a result nobody can read. Written against the set of statuses that
    // carry a result rather than against "errored", so that cancellation is one entry in
    // that set rather than an inverted condition here.
    message: "a score is present exactly when the run produced a result",
    path: ["score"],
  })
  .refine((report) => (report.status === "errored") === (report.errorKind !== null), {
    // Also both directions. An errored run without a kind is an error nobody can act on or
    // aggregate, and a kind on a run that produced a result is an attribution for something
    // that did not happen.
    message: "an error kind is present exactly when the run errored",
    path: ["errorKind"],
  })
  .refine(
    (report) =>
      report.score === null || report.scoreCap === null || report.score <= report.scoreCap,
    {
      // A score above its own recorded ceiling means the cap was recorded and not applied,
      // which is worse than not recording it: the report would explain itself incorrectly.
      message: "a score may not exceed the cap recorded beside it",
      path: ["score"],
    },
  );

export type CheckResult = z.infer<typeof CheckResultSchema>;
export type CategoryScore = z.infer<typeof CategoryScoreSchema>;
export type BenchReport = z.infer<typeof BenchReportSchema>;

/**
 * The report for a run the benchmark itself broke on.
 *
 * `evaluator` is the kind reserved for NapBench's own crashes, and this is what raises it: an
 * exception escaping the runner is a bug in the instrument, and recording it as anything else
 * would file it against the model it was measuring. Written as a report rather than left as a
 * stack trace so that a suite keeps going, the crash lands in the infrastructure column where
 * it belongs, and the tool says the suite is not comparable — which it is not.
 *
 * The metrics are passed in rather than zeroed, because the run's events are still in the
 * store the caller holds: a crash after the agent worked should record the work.
 */
export function evaluatorErrorReport(input: {
  runId: string;
  taskId: string;
  sessionId: string;
  weights: CategoryWeights;
  metrics: RunMetrics;
  /**
   * What the crashed run was configured as, when the caller knows.
   *
   * Worth carrying even here: a crash is one of the runs somebody most wants to reproduce, and
   * the configuration is what they would have to guess at otherwise.
   */
  configuration?: RunConfiguration;
}): BenchReport {
  return {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    // A crash says nothing about which turn was running, and guessing would put a real turn
    // id on a report whose failure had nothing to do with that turn.
    turnId: null,
    status: "errored",
    errorKind: "evaluator",
    gates: [],
    scoreCap: null,
    score: null,
    categories: [],
    weights: input.weights,
    configuration: input.configuration ?? { ...UNRECORDED_CONFIGURATION },
    checks: [],
    metrics: input.metrics,
    screenshots: [],
    visual: VISUAL_NOT_RUN,
  };
}

/** Indented, because a committed report is read and diffed by people. */
export function serialiseBenchReport(report: BenchReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function parseBenchReport(input: unknown): Result<BenchReport, string> {
  const parsed = BenchReportSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };

  return { ok: false, error: describeParseFailure(parsed.error, "report") };
}
