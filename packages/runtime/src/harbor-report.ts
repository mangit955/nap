/**
 * What a Terminal-Bench job under Harbor found, read back out of its job directory.
 *
 * Harbor's own summary is a mean reward. A baseline needs more than that to be read honestly: the
 * uncertainty of a rate measured on a few dozen tasks, what Nap said about its own work next to
 * what the hidden tests said, what the run cost by Nap's own accounting, and why the failures
 * failed. See harbor/README.md, "Scoring a task set", for how a job is run and this is produced.
 *
 * **Nap's claim** is the turn's own ending. `completed` means the agent stopped calling tools and
 * handed back, which is what Nap shows a person as done; every other ending (the step budget, the
 * model unreachable, Harbor giving up on the trial) is the agent not claiming it. Nothing reads
 * the agent's prose: a turn that completes by saying it could not do the task still counts as a
 * claim, which makes the claim generous and any agreement it earns an upper bound.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isFreeModel } from "@nap/shared/model-capabilities";
import { estimateCost, PRICE_TABLE_VERSION } from "@nap/shared/pricing";
import { addUsage, type TokenUsage } from "@nap/shared/usage";
import { z } from "zod";
import { HARBOR_TASK_FILES, SCRIPTED_MODEL } from "./harbor-task-args.ts";
import { type TaskTurnResult, TaskTurnResultSchema } from "./task-turn.ts";

/** One trial, reduced to what the report reads. */
export type TrialRecord = {
  task: string;
  /**
   * Harbor's name for the trial, or `null` for a task the job planned that has no finished trial:
   * Harbor writes a trial's result only when it ends, so a job stopped early (the workflow's time
   * limit, a cancel) leaves these. They count as failures, so a cut-short run cannot report a rate
   * over fewer tasks than it set out to run.
   */
  trial: string | null;
  /** The hidden tests' reward, 1 for a pass. `null` when the verifier never scored the trial. */
  reward: number | null;
  /** The exception Harbor recorded for the trial, by type, or `null`. */
  exception: string | null;
  /** What Nap's entrypoint wrote, or `null` when it wrote nothing readable. */
  nap: TaskTurnResult | null;
};

/**
 * Why a trial did not pass, as one of a few kinds a reader can act on.
 *
 * Ordered by what decides it: Harbor's own exception first, because when Harbor times a trial
 * out Nap's turn is cancelled and its own ending says only that.
 */
export const FAILURE_KINDS = {
  unfinished: "The job stopped before the trial finished",
  harbor_timeout: "Harbor's time limit for the task ran out",
  harness_error: "The harness failed before or around the agent (no fault of the agent)",
  step_budget: "Nap's step budget ran out",
  model_unavailable: "The model could not be reached",
  claimed_done_tests_failed: "Nap claimed done; the hidden tests failed",
  turn_failed: "Nap's turn failed for another reason",
  no_agent_result: "The agent left no result, or one this report could not read",
  not_scored: "The verifier gave no reward",
} as const;
export type FailureKind = keyof typeof FAILURE_KINDS;

export function failureKind(trial: TrialRecord): FailureKind | null {
  if (trial.trial === null) return "unfinished";
  if (trial.reward !== null && trial.reward >= 1) return null;
  if (trial.exception === "AgentTimeoutError") return "harbor_timeout";
  if (trial.exception !== null) return "harness_error";
  if (trial.reward === null) return "not_scored";
  if (trial.nap === null) return "no_agent_result";
  if (trial.nap.status === "completed") return "claimed_done_tests_failed";
  if (trial.nap.failure?.reason === "budget_exceeded") return "step_budget";
  if (trial.nap.failure?.reason === "model_unavailable") return "model_unavailable";
  return "turn_failed";
}

/**
 * The 95% Wilson score interval for a pass rate.
 *
 * Wilson rather than the textbook normal interval, which runs below zero and above one at the
 * rates a hard benchmark produces, and collapses to nothing at 0 of n.
 */
export function wilsonInterval(passed: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = passed / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export type BenchmarkReport = {
  models: string[];
  /** The dataset and its content ref, as Harbor resolved them, when the job recorded them. */
  dataset: string | null;
  trials: number;
  passed: number;
  passRate: number;
  interval: { low: number; high: number };
  harnessErrors: number;
  /** Planned trials the job never finished; counted as failures above. */
  unfinished: number;
  agreement: {
    claimedPassed: number;
    claimedFailed: number;
    unclaimedPassed: number;
    unclaimedFailed: number;
    /**
     * Of the trials Nap ran, those where the claim and the tests agreed. A trial the harness lost
     * or never finished is left out: Nap made no claim there to agree or disagree, and counting it
     * as "did not claim, failed" would raise the agreement the flakier the harness got.
     */
    rate: number;
    /** Trials left out of the table above for that reason. */
    notRun: number;
  };
  cost: {
    usd: number;
    /** Mean over the trials that could be priced; `null` when none could. */
    perPricedTrialUsd: number | null;
    priced: number;
    unpriced: number;
    priceTableVersion: string;
  };
  usage: TokenUsage;
  requests: number;
  /** The agent's steps. A reviewer's are under `review`, never here. */
  steps: number;
  /**
   * What the reviewer did, when the run had one (ADR-0036); `null` for a run without, such as the
   * baseline. Its tokens and cost are already inside `usage` and `cost`, and are its share of them.
   */
  review: {
    /** Trials whose claim was reviewed at least once. */
    reviewed: number;
    /** Trials the reviewer sent back at least once, and how each ended. */
    sentBack: number;
    sentBackPassed: number;
    sentBackClaimedFailed: number;
    sentBackStepBudget: number;
    /**
     * Each trial in which a review's commands wrote files to the task's directory, with the files,
     * and whether every such review's writes were put back. One that was not is where a review
     * could have changed the answer itself rather than through the agent (ADR-0036 D5).
     */
    wrote: Array<{ task: string; files: string[]; restored: boolean }>;
    /**
     * Trials with a review whose writes could not be read (its start was never marked, or the
     * listing failed), so nothing was put back and nothing is known about what it wrote.
     */
    unknownWrites: string[];
    reviews: number;
    steps: number;
    usage: TokenUsage;
    usd: number;
  } | null;
  failures: Partial<Record<FailureKind, string[]>>;
  rows: Array<{
    task: string;
    passed: boolean;
    claimedDone: boolean;
    kind: FailureKind | null;
    steps: number | null;
    requests: number | null;
    usage: TokenUsage | null;
    usd: number | null;
    durationMs: number | null;
    /** Reviews of the trial, and how many sent it back; `null` when the run had no reviewer. */
    reviews: number | null;
    sentBack: number | null;
  }>;
};

const passedTrial = (trial: TrialRecord) => trial.reward !== null && trial.reward >= 1;
const claimedDone = (trial: TrialRecord) => trial.nap?.status === "completed";

/** What a trial cost: nothing on a free model, the price table's estimate otherwise. */
function trialCost(nap: TaskTurnResult | null): number | null {
  if (nap === null) return null;
  if (isFreeModel(nap.model)) return 0;
  return estimateCost(nap.model, nap.usage)?.usd ?? null;
}

export function summarise(
  trials: readonly TrialRecord[],
  dataset: string | null = null,
): BenchmarkReport {
  const sorted = [...trials].sort((a, b) => a.task.localeCompare(b.task));
  const rows = sorted.map((trial) => {
    const kind = failureKind(trial);
    return {
      task: trial.task,
      passed: passedTrial(trial),
      claimedDone: claimedDone(trial),
      kind,
      // Nap ran and the tests judged it: only then is there a claim and a verdict to compare.
      ran:
        trial.nap !== null &&
        trial.reward !== null &&
        kind !== "harness_error" &&
        kind !== "unfinished",
      steps: trial.nap?.steps ?? null,
      requests: trial.nap?.requests ?? null,
      usage: trial.nap?.usage ?? null,
      usd: trialCost(trial.nap),
      durationMs: trial.nap?.durationMs ?? null,
      reviews: trial.nap?.reviews?.length ?? null,
      sentBack: trial.nap?.reviews?.filter((review) => review.sentBack).length ?? null,
    };
  });

  const count = (predicate: (row: (typeof rows)[number]) => boolean) =>
    rows.filter(predicate).length;
  const passed = count((row) => row.passed);
  const ran = count((row) => row.ran);
  const claimedPassed = count((row) => row.ran && row.claimedDone && row.passed);
  const unclaimedFailed = count((row) => row.ran && !row.claimedDone && !row.passed);

  const failures: Partial<Record<FailureKind, string[]>> = {};
  for (const row of rows) {
    if (row.kind === null) continue;
    failures[row.kind] = [...(failures[row.kind] ?? []), row.task];
  }

  const priced = count((row) => row.usd !== null);
  const results = sorted.flatMap((trial) => (trial.nap === null ? [] : [trial.nap]));
  // Priced once per model on the summed usage, not by adding each row's rounded figure, so the
  // total carries one rounding rather than one per trial.
  const usageByModel = new Map<string, TokenUsage>();
  for (const result of results)
    if (trialCost(result) !== null)
      usageByModel.set(
        result.model,
        addUsage(
          usageByModel.get(result.model) ?? { inputTokens: 0, outputTokens: 0 },
          result.usage,
        ),
      );
  const usd = [...usageByModel].reduce(
    (sum, [model, usage]) =>
      sum + (isFreeModel(model) ? 0 : (estimateCost(model, usage)?.usd ?? 0)),
    0,
  );

  return {
    models: [...new Set(results.map((result) => result.model))].sort(),
    dataset,
    trials: rows.length,
    passed,
    passRate: rows.length === 0 ? 0 : passed / rows.length,
    interval: wilsonInterval(passed, rows.length),
    harnessErrors: count((row) => row.kind === "harness_error"),
    unfinished: count((row) => row.kind === "unfinished"),
    agreement: {
      claimedPassed,
      claimedFailed: count((row) => row.ran && row.claimedDone && !row.passed),
      unclaimedPassed: count((row) => row.ran && !row.claimedDone && row.passed),
      unclaimedFailed,
      rate: ran === 0 ? 0 : (claimedPassed + unclaimedFailed) / ran,
      notRun: rows.length - ran,
    },
    cost: {
      usd: round(usd),
      perPricedTrialUsd: priced === 0 ? null : round(usd / priced),
      priced,
      unpriced: rows.length - priced,
      priceTableVersion: PRICE_TABLE_VERSION,
    },
    usage: results.reduce((total, result) => addUsage(total, result.usage), {
      inputTokens: 0,
      outputTokens: 0,
    }),
    requests: results.reduce((total, result) => total + result.requests, 0),
    steps: results.reduce((total, result) => total + result.steps, 0),
    review: reviewSummary(sorted),
    failures,
    rows: rows.map(({ ran: _ran, ...row }) => row),
  };
}

/** The reviewer's share of a run, or `null` when no trial in it had a reviewer. */
function reviewSummary(trials: readonly TrialRecord[]): BenchmarkReport["review"] {
  const withReviewer = trials.filter((trial) => trial.nap?.reviews !== undefined);
  if (withReviewer.length === 0) return null;
  const sentBack = withReviewer.filter((trial) =>
    trial.nap?.reviews?.some((review) => review.sentBack),
  );
  const all = withReviewer.flatMap((trial) => trial.nap?.reviews ?? []);
  const usage = all.reduce((total, review) => addUsage(total, review.usage), {
    inputTokens: 0,
    outputTokens: 0,
  });
  const usd = withReviewer.reduce((sum, trial) => {
    const nap = trial.nap;
    if (nap === null || isFreeModel(nap.model)) return sum;
    const spent = (nap.reviews ?? []).reduce((total, review) => addUsage(total, review.usage), {
      inputTokens: 0,
      outputTokens: 0,
    });
    return sum + (estimateCost(nap.model, spent)?.usd ?? 0);
  }, 0);
  return {
    reviewed: withReviewer.filter((trial) => (trial.nap?.reviews?.length ?? 0) > 0).length,
    sentBack: sentBack.length,
    sentBackPassed: sentBack.filter(passedTrial).length,
    sentBackClaimedFailed: sentBack.filter(
      (trial) => failureKind(trial) === "claimed_done_tests_failed",
    ).length,
    sentBackStepBudget: sentBack.filter((trial) => failureKind(trial) === "step_budget").length,
    wrote: withReviewer.flatMap((trial) => {
      const writing = (trial.nap?.reviews ?? []).filter(
        (review) => (review.wrote ?? []).length > 0,
      );
      const files = [...new Set(writing.flatMap((review) => review.wrote ?? []))];
      const restored = writing.every((review) => review.restored);
      return files.length === 0 ? [] : [{ task: trial.task, files, restored }];
    }),
    unknownWrites: withReviewer
      .filter((trial) => (trial.nap?.reviews ?? []).some((review) => review.wrote === null))
      .map((trial) => trial.task),
    reviews: all.length,
    steps: all.reduce((total, review) => total + review.steps, 0),
    usage,
    usd: round(usd),
  };
}

/** The same five places `estimateCost` keeps: a benchmark task costs fractions of a cent. */
function round(usd: number): number {
  return Math.round(usd * 100_000) / 100_000;
}

const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;
const dollars = (usd: number | null) => (usd === null ? "—" : `$${usd.toFixed(4)}`);

export function renderReport(report: BenchmarkReport): string {
  const { agreement, cost, interval } = report;
  const reviewed = report.review !== null;
  const lines = [
    "# Terminal-Bench report",
    "",
    `Model: ${report.models.join(", ") || "none recorded"}`,
    ...(report.dataset === null ? [] : [`Dataset: ${report.dataset}`]),
    "",
    ...(report.models.includes(SCRIPTED_MODEL)
      ? ["**A wiring check on a scripted model: these figures say nothing about the agent.**", ""]
      : []),
    "## Pass rate",
    "",
    `**${report.passed} of ${report.trials} passed (${percent(report.passRate)})**, ` +
      `95% interval ${percent(interval.low)} to ${percent(interval.high)} (Wilson).`,
    "",
    ...(report.unfinished > 0
      ? [
          `**Incomplete: ${report.unfinished} of ${report.trials} planned trials never finished**, ` +
            "and count as failures here.",
          "",
        ]
      : []),
    "Every planned trial counts, a harness error or an unfinished trial as a failure " +
      `(${report.harnessErrors} and ${report.unfinished} here). On a few dozen tasks the interval ` +
      "is wide: at 25 tasks it spans up to about 37 points (7 of 25 is 14% to 48%), so one run " +
      "cannot tell apart two agents a few points apart.",
    "",
    "## Claimed done against the hidden tests",
    "",
    "| | Tests passed | Tests failed |",
    "|---|---|---|",
    `| Claimed done | ${agreement.claimedPassed} | ${agreement.claimedFailed} |`,
    `| Did not claim | ${agreement.unclaimedPassed} | ${agreement.unclaimedFailed} |`,
    "",
    `Agreement ${percent(agreement.rate)} of the ${report.trials - agreement.notRun} trials Nap ` +
      `ran (${agreement.notRun} left out: a harness error, no result, no reward, or never ` +
      "finished). " +
      "Claimed done means the turn completed: the agent stopped and handed back, which Nap shows " +
      "as done. Its prose is not read.",
    "",
    "## Cost",
    "",
    (cost.perPricedTrialUsd === null
      ? "No trial could be priced"
      : `${dollars(cost.usd)} for ${cost.priced} priced trials, ${dollars(cost.perPricedTrialUsd)} a trial`) +
      (cost.unpriced > 0
        ? `; ${cost.unpriced} not priced (no result, or a paid model with no price)`
        : "") +
      `. Nap's token counts at price table ${cost.priceTableVersion}, a \`:free\` model at $0: ` +
      "an estimate, not a bill.",
    "",
    `${report.steps} steps, ${report.requests} model requests, ${report.usage.inputTokens} input ` +
      `(${report.usage.cacheReadTokens ?? 0} from cache) and ${report.usage.outputTokens} output tokens.`,
    "",
    ...(report.review === null ? [] : renderReview(report.review)),
    "## Failures by kind",
    "",
    ...Object.entries(report.failures).map(
      ([kind, tasks]) =>
        `- **${FAILURE_KINDS[kind as FailureKind]}** (${tasks.length}): ${tasks.join(", ")}`,
    ),
    ...(Object.keys(report.failures).length === 0 ? ["None."] : []),
    "",
    "## Tasks",
    "",
    `| Task | Passed | Claimed done | Failure | Steps | Requests | Cost | Time |${reviewed ? " Reviews (sent back) |" : ""}`,
    `|---|---|---|---|---|---|---|---|${reviewed ? "---|" : ""}`,
    ...report.rows.map(
      (row) =>
        `| ${row.task} | ${row.passed ? "yes" : "no"} | ${row.claimedDone ? "yes" : "no"} | ` +
        `${row.kind ?? ""} | ${row.steps ?? "—"} | ${row.requests ?? "—"} | ${dollars(row.usd)} | ` +
        `${row.durationMs === null ? "—" : `${Math.round(row.durationMs / 1_000)}s`} |` +
        (reviewed
          ? ` ${row.reviews === null ? "—" : `${row.reviews} (${row.sentBack ?? 0})`} |`
          : ""),
    ),
    "",
  ];
  return lines.join("\n");
}

/**
 * Only the fields of Harbor's per-trial `result.json` the report reads; the rest is Harbor's and
 * may change without this caring.
 */
const HarborTrialSchema = z.looseObject({
  task_name: z.string().min(1),
  trial_name: z.string().min(1),
  verifier_result: z
    .looseObject({ rewards: z.looseObject({ reward: z.number() }).nullish() })
    .nullish(),
  exception_info: z.looseObject({ exception_type: z.string() }).nullish(),
});

/** The part of a job's `config.json` that names the datasets it ran. */
const HarborJobConfigSchema = z.looseObject({
  datasets: z
    .array(z.looseObject({ name: z.string().nullish(), ref: z.string().nullish() }))
    .nullish(),
});

/**
 * The part of a job's `lock.json` that lists its trials: one entry per trial Harbor resolved, so
 * a glob in `-i` is already expanded and each of several attempts at a task is its own entry.
 */
const HarborJobLockSchema = z.looseObject({
  trials: z.array(z.looseObject({ task: z.looseObject({ name: z.string().min(1) }) })),
});

export type JobRecord = {
  /** Every planned task: a finished trial, or a record that it never finished. */
  trials: TrialRecord[];
  /** `name@ref` of each dataset the job ran, as Harbor resolved it, or `null`. */
  dataset: string | null;
};

/**
 * A Harbor job directory read back: each subdirectory with a trial's `result.json`, plus a record
 * for each trial the job's `lock.json` planned beyond those, which is a trial that never ended.
 */
export function readJob(jobDir: string): JobRecord {
  const config = HarborJobConfigSchema.safeParse(readJson(join(jobDir, "config.json")));
  const datasets = config.success ? (config.data.datasets ?? []) : [];
  const trials: TrialRecord[] = [];
  for (const entry of readdirSync(jobDir).sort()) {
    const dir = join(jobDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const harbor = HarborTrialSchema.safeParse(readJson(join(dir, "result.json")));
    if (!harbor.success) continue;
    const nap = TaskTurnResultSchema.safeParse(
      readJson(join(dir, "agent", HARBOR_TASK_FILES.result)),
    );
    trials.push({
      task: harbor.data.task_name,
      trial: harbor.data.trial_name,
      reward: harbor.data.verifier_result?.rewards?.reward ?? null,
      exception: harbor.data.exception_info?.exception_type ?? null,
      nap: nap.success ? nap.data : null,
    });
  }
  // Counted per task rather than matched by name, so a task run several times is short exactly
  // as many records as it has attempts that never finished.
  const lock = HarborJobLockSchema.safeParse(readJson(join(jobDir, "lock.json")));
  const unmatched = new Map<string, number>();
  for (const planned of lock.success ? lock.data.trials : [])
    unmatched.set(planned.task.name, (unmatched.get(planned.task.name) ?? 0) + 1);
  for (const trial of trials) unmatched.set(trial.task, (unmatched.get(trial.task) ?? 0) - 1);
  for (const [task, missing] of unmatched)
    for (let n = 0; n < missing; n += 1)
      trials.push({ task, trial: null, reward: null, exception: null, nap: null });
  const named = datasets.flatMap((dataset) =>
    dataset.name ? [dataset.ref ? `${dataset.name}@${dataset.ref}` : dataset.name] : [],
  );
  return { trials, dataset: named.length === 0 ? null : named.join(", ") };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function renderReview(review: NonNullable<BenchmarkReport["review"]>): string[] {
  return [
    "## Review",
    "",
    `The reviewer checked ${review.reviewed} claims of done and sent ${review.sentBack} back with ` +
      `a problem it proved. Of those, ${review.sentBackPassed} passed in the end, ` +
      `${review.sentBackClaimedFailed} were claimed done again and failed, and ` +
      `${review.sentBackStepBudget} ran out of steps fixing it.`,
    "",
    `${review.reviews} reviews took ${review.steps} model calls and ${dollars(review.usd)}. Both ` +
      "are inside the totals above, and none of those calls is counted in the agent's steps, " +
      "which stay capped across every round of a task.",
    "",
    ...renderWrote(review.wrote, review.unknownWrites),
    "",
  ];
}

/** Where a review's commands wrote in a task's directory, and whether that was put back. */
function renderWrote(
  wrote: NonNullable<BenchmarkReport["review"]>["wrote"],
  unknown: readonly string[],
): string[] {
  const unread =
    unknown.length === 0
      ? []
      : [
          "**What a review wrote could not be read, so nothing was put back and a review could " +
            `have changed the answer itself:** ${unknown.join(", ")}.`,
        ];
  if (wrote.length === 0)
    return unknown.length === 0
      ? ["No review's commands wrote a file in a task's directory."]
      : unread;
  const list = (entries: typeof wrote) =>
    entries.map((entry) => `${entry.task} (${entry.files.join(", ")})`).join("; ");
  const kept = wrote.filter((entry) => !entry.restored);
  const putBack = wrote.filter((entry) => entry.restored);
  return [
    ...(putBack.length === 0
      ? []
      : [`Put back after the review, as it was before: ${list(putBack)}.`]),
    ...(kept.length === 0
      ? []
      : [`**Not put back, so the review itself could have changed the answer:** ${list(kept)}.`]),
    ...unread,
  ];
}
