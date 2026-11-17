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
  no_agent_result: "The agent left no result",
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
  steps: number;
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
      ran: trial.nap !== null && kind !== "harness_error" && kind !== "unfinished",
      steps: trial.nap?.steps ?? null,
      requests: trial.nap?.requests ?? null,
      usage: trial.nap?.usage ?? null,
      usd: trialCost(trial.nap),
      durationMs: trial.nap?.durationMs ?? null,
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

  const prices = rows.flatMap((row) => (row.usd === null ? [] : [row.usd]));
  const usd = prices.reduce((sum, value) => sum + value, 0);
  const results = sorted.flatMap((trial) => (trial.nap === null ? [] : [trial.nap]));

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
      perPricedTrialUsd: prices.length === 0 ? null : round(usd / prices.length),
      priced: prices.length,
      unpriced: rows.length - prices.length,
      priceTableVersion: PRICE_TABLE_VERSION,
    },
    usage: results.reduce((total, result) => addUsage(total, result.usage), {
      inputTokens: 0,
      outputTokens: 0,
    }),
    requests: results.reduce((total, result) => total + result.requests, 0),
    steps: results.reduce((total, result) => total + result.steps, 0),
    failures,
    rows: rows.map(({ ran: _ran, ...row }) => row),
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
      "is wide, about twenty points either side at 25: two runs whose rates differ by less than " +
      "that have not shown a difference.",
    "",
    "## Claimed done against the hidden tests",
    "",
    "| | Tests passed | Tests failed |",
    "|---|---|---|",
    `| Claimed done | ${agreement.claimedPassed} | ${agreement.claimedFailed} |`,
    `| Did not claim | ${agreement.unclaimedPassed} | ${agreement.unclaimedFailed} |`,
    "",
    `Agreement ${percent(agreement.rate)} of the ${report.trials - agreement.notRun} trials Nap ` +
      `ran (${agreement.notRun} left out: a harness error, no result, or never finished). ` +
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
    "| Task | Passed | Claimed done | Failure | Steps | Requests | Cost | Time |",
    "|---|---|---|---|---|---|---|---|",
    ...report.rows.map(
      (row) =>
        `| ${row.task} | ${row.passed ? "yes" : "no"} | ${row.claimedDone ? "yes" : "no"} | ` +
        `${row.kind ?? ""} | ${row.steps ?? "—"} | ${row.requests ?? "—"} | ${dollars(row.usd)} | ` +
        `${row.durationMs === null ? "—" : `${Math.round(row.durationMs / 1_000)}s`} |`,
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

/** The part of a job's `config.json` that says what it set out to run. */
const HarborJobConfigSchema = z.looseObject({
  datasets: z
    .array(
      z.looseObject({
        name: z.string().nullish(),
        ref: z.string().nullish(),
        task_names: z.array(z.string()).nullish(),
      }),
    )
    .nullish(),
});

export type JobRecord = {
  /** Every planned task: a finished trial, or a record that it never finished. */
  trials: TrialRecord[];
  /** `name@ref` of each dataset the job ran, as Harbor resolved it, or `null`. */
  dataset: string | null;
};

/**
 * A Harbor job directory read back: each subdirectory with a trial's `result.json`, plus a record
 * for each task the job's `config.json` planned that has none, which is a trial that never ended.
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
  const finished = new Set(trials.map((trial) => trial.task));
  for (const task of datasets.flatMap((dataset) => dataset.task_names ?? []))
    if (!finished.has(task))
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
