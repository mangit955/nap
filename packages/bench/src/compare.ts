/**
 * Two runs, and what moved between them — the question the whole benchmark exists to answer.
 *
 * A score on its own says how good a configuration is; a comparison says whether a change
 * *helped*, which is the thing anybody actually decides on. And the per-check half is where
 * the answer lives: "browser fell twelve points" is a fact, and "the filter check that used to
 * pass now fails" is an explanation somebody can act on.
 *
 * **It refuses more than it computes.** Two runs scored over different effective weight vectors
 * are not two measurements of the same thing — renormalisation means a score is only meaningful
 * relative to the categories that produced it — so subtracting them produces a plausible number
 * that is not about anything. The day a visual judge lands, every historical run would otherwise
 * be silently repriced against the ones after it. Hence the refusals, and hence a typed error
 * rather than a thrown one: the caller is a CLI whose job is to explain the problem. See
 * docs/adr/0002.
 *
 * Two runs, and exactly two. Comparing three is a different tool with a different shape — a
 * table rather than a diff — and is explicitly out of scope for v1.
 */

import type { Result } from "@nap/shared/result";
import type { Category, CategoryWeights } from "./category.ts";
import type { ErrorKind } from "./error-kind.ts";
import type { BenchReport, CheckOutcome } from "./report.ts";
import { carriesScore, type RunStatus } from "./status.ts";

/** How one side of the comparison ended, which is all a comparison needs of a report's head. */
export type RunSide = {
  runId: string;
  status: RunStatus;
  /** Null when the run produced no result, exactly as the report has it. */
  score: number | null;
  errorKind: ErrorKind | null;
};

export type CategoryDelta = {
  category: Category;
  baseline: number;
  candidate: number;
  delta: number;
  /** Shared by both sides — a differing vector is refused before this is built. */
  effectiveWeight: number;
};

/**
 * What happened to one check.
 *
 * *Added* and *removed* are kept rather than dropped: a check that exists on one side only is
 * usually the task having changed underneath the comparison, which is the most important thing
 * a reader can be told and the easiest to hide by quietly intersecting the two lists.
 */
export type CheckMovement = "fixed" | "broken" | "unchanged" | "added" | "removed";

export type CheckDelta = {
  checkId: string;
  category: Category;
  baseline: CheckOutcome | null;
  candidate: CheckOutcome | null;
  movement: CheckMovement;
};

/** One figure on both sides. Absent entirely when neither run could supply it. */
export type MetricDelta = { baseline: number; candidate: number; delta: number };

/**
 * The route, as far as the event stream can describe it.
 *
 * Every field optional for one reason: metrics the log cannot supply are absent rather than
 * zero (see `metrics.ts`), and a delta between two absences would be the one number in a
 * comparison that traces back to no measurement at all.
 */
export type MetricComparison = {
  toolCalls?: MetricDelta;
  toolFailures?: MetricDelta;
  commands?: MetricDelta;
  filesChanged?: MetricDelta;
  inputTokens?: MetricDelta;
  outputTokens?: MetricDelta;
  turnDurationMs?: MetricDelta;
};

export type RunComparison = {
  taskId: string;
  baseline: RunSide;
  candidate: RunSide;
  /** Null when either side has no score, since a delta from nothing is not a delta. */
  scoreDelta: number | null;
  categories: CategoryDelta[];
  checks: CheckDelta[];
  metrics: MetricComparison;
  /**
   * Both runs scored the same and got there differently.
   *
   * Called out because it is the finding a score alone destroys: two models that agree on the
   * result and disagree on the route are the interesting case for cost, and for trusting one
   * of them more than the other.
   */
  sameScoreDifferentRoute: boolean;
};

export function compareRuns(
  baseline: BenchReport,
  candidate: BenchReport,
): Result<RunComparison, string> {
  if (baseline.taskId !== candidate.taskId) {
    return {
      ok: false,
      error:
        `these are runs of different tasks — "${baseline.taskId}" and "${candidate.taskId}". ` +
        "A comparison is between two runs of the same task; nothing else holds still.",
    };
  }

  const refusal = weightsRefusal(baseline, candidate);
  if (refusal !== null) return { ok: false, error: refusal };

  const metrics = compareMetrics(baseline, candidate);
  const scoreDelta =
    baseline.score === null || candidate.score === null ? null : candidate.score - baseline.score;

  return {
    ok: true,
    value: {
      taskId: baseline.taskId,
      baseline: sideOf(baseline),
      candidate: sideOf(candidate),
      scoreDelta,
      categories: compareCategories(baseline, candidate),
      checks: compareChecks(baseline, candidate),
      metrics,
      sameScoreDifferentRoute: scoreDelta === 0 && routeDiffers(metrics),
    },
  };
}

/**
 * Why these two runs may not be subtracted, or null if they may.
 *
 * Both the configured vector and the effective one, because they answer different questions: a
 * changed configuration means somebody reweighted the benchmark, and a changed effective vector
 * means the runs scored over different sets of categories. Either makes the two numbers scales
 * apart, and only the second is visible in the report's own arithmetic.
 *
 * Skipped entirely when either run has no score. There is nothing to reprice on a run that
 * produced no number, and refusing there would make an errored run incomparable with anything —
 * which is precisely when somebody most wants to see what the other side did.
 */
function weightsRefusal(baseline: BenchReport, candidate: BenchReport): string | null {
  if (!carriesScore(baseline.status) || !carriesScore(candidate.status)) return null;

  if (!sameWeights(baseline.weights, candidate.weights)) {
    return (
      "these runs were scored under different category weights " +
      `(${describeWeights(baseline.weights)} and ${describeWeights(candidate.weights)}), ` +
      "so their scores are not on the same scale and a difference between them means nothing."
    );
  }

  const before = effectiveVector(baseline);
  const after = effectiveVector(candidate);
  if (before !== after) {
    return (
      `these runs have different effective weight vectors — ${before} and ${after}. ` +
      "An absent category renormalises the rest, so the two scores are on different scales " +
      "and the difference between them is not a measurement."
    );
  }

  return null;
}

function sameWeights(baseline: CategoryWeights, candidate: CategoryWeights): boolean {
  return (
    baseline.functional === candidate.functional &&
    baseline.browser === candidate.browser &&
    baseline.visual === candidate.visual &&
    baseline.code === candidate.code
  );
}

/** The effective vector as one comparable string, which is also what a refusal can print. */
function effectiveVector(report: BenchReport): string {
  return report.categories
    .map((entry) => `${entry.category} ${entry.effectiveWeight.toFixed(1)}%`)
    .join(", ");
}

function describeWeights(weights: CategoryWeights): string {
  return `${weights.functional}/${weights.browser}/${weights.visual}/${weights.code}`;
}

function sideOf(report: BenchReport): RunSide {
  return {
    runId: report.runId,
    status: report.status,
    score: report.score,
    errorKind: report.errorKind,
  };
}

/**
 * Categories in the baseline's order, which is the canonical one every report is built in.
 *
 * Only the categories both runs scored appear, and by this point that is all of them: a
 * differing set was refused above, and an unscored run has none at all.
 */
function compareCategories(baseline: BenchReport, candidate: BenchReport): CategoryDelta[] {
  const after = new Map(candidate.categories.map((entry) => [entry.category, entry]));

  return baseline.categories.flatMap((entry) => {
    const other = after.get(entry.category);
    if (other === undefined) return [];

    return [
      {
        category: entry.category,
        baseline: entry.score,
        candidate: other.score,
        delta: other.score - entry.score,
        effectiveWeight: entry.effectiveWeight,
      },
    ];
  });
}

/**
 * Every check either run recorded, baseline order first and then whatever the candidate added.
 *
 * Ordered rather than grouped by movement, because the order a task declares its checks in is
 * how somebody reads them — and a reader looking for one check id should not have to know
 * whether it broke to know where to look.
 */
function compareChecks(baseline: BenchReport, candidate: BenchReport): CheckDelta[] {
  const after = new Map(candidate.checks.map((check) => [check.checkId, check]));
  const deltas: CheckDelta[] = [];

  for (const check of baseline.checks) {
    const other = after.get(check.checkId);
    deltas.push({
      checkId: check.checkId,
      category: check.category,
      baseline: check.outcome,
      candidate: other?.outcome ?? null,
      movement: movementOf(check.outcome, other?.outcome ?? null),
    });
  }

  const before = new Set(baseline.checks.map((check) => check.checkId));
  for (const check of candidate.checks) {
    if (before.has(check.checkId)) continue;
    deltas.push({
      checkId: check.checkId,
      category: check.category,
      baseline: null,
      candidate: check.outcome,
      movement: "added",
    });
  }

  return deltas;
}

/**
 * What one check's pair of outcomes means.
 *
 * `absent` counts as neither fixed nor broken in either direction: it means the run never asked,
 * which is a fact about the circumstances rather than about the agent — the same distinction
 * scoring makes, and it would be undone by calling passed-to-absent a regression.
 */
function movementOf(baseline: CheckOutcome | null, candidate: CheckOutcome | null): CheckMovement {
  if (candidate === null) return "removed";
  if (baseline === null) return "added";
  if (baseline === candidate) return "unchanged";
  if (baseline === "failed" && candidate === "passed") return "fixed";
  if (baseline === "passed" && candidate === "failed") return "broken";
  return "unchanged";
}

function compareMetrics(baseline: BenchReport, candidate: BenchReport): MetricComparison {
  const before = baseline.metrics;
  const after = candidate.metrics;

  return {
    ...delta("toolCalls", before.toolCalls, after.toolCalls),
    ...delta("toolFailures", before.toolFailures, after.toolFailures),
    ...delta("commands", before.commands, after.commands),
    ...delta("filesChanged", before.filesChanged, after.filesChanged),
    ...delta("inputTokens", before.tokens?.inputTokens, after.tokens?.inputTokens),
    ...delta("outputTokens", before.tokens?.outputTokens, after.tokens?.outputTokens),
    ...delta("turnDurationMs", before.turnDurationMs, after.turnDurationMs),
  };
}

/**
 * One figure, present only when both runs measured it.
 *
 * A figure one side is missing is dropped rather than defaulted to zero: the absent side did
 * not measure nothing, it measured nothing *measurable*, and a delta against a stand-in zero
 * would read as a change the runs never made.
 */
function delta<K extends keyof MetricComparison>(
  key: K,
  baseline: number | undefined,
  candidate: number | undefined,
): Partial<Record<K, MetricDelta>> {
  if (baseline === undefined || candidate === undefined) return {};
  return { [key]: { baseline, candidate, delta: candidate - baseline } } as Record<K, MetricDelta>;
}

/**
 * The figures that describe the *shape* of a route rather than its size.
 *
 * Duration and token counts are deliberately not here. They vary between two runs that did
 * exactly the same thing — a millisecond either way, a few tokens of sampling difference — so a
 * flag that watched them would announce "different route" on every pair, which is the fastest
 * way to make a signal worth ignoring. What actually distinguishes two routes is what the agent
 * *did*: how many tools it called, how many of those failed, how many commands it ran and how
 * many files it ended up touching. Both are still printed; only these decide the claim.
 */
const ROUTE_SHAPE: (keyof MetricComparison)[] = [
  "toolCalls",
  "toolFailures",
  "commands",
  "filesChanged",
];

/** Whether the two runs did different things, as opposed to taking different lengths of time. */
function routeDiffers(metrics: MetricComparison): boolean {
  return ROUTE_SHAPE.some((key) => (metrics[key]?.delta ?? 0) !== 0);
}

/**
 * The comparison as a person reads it: the headline, the categories, then what explains them.
 *
 * Unchanged checks are left out. They are already accounted for by the category lines above,
 * and a diff that prints everything is one nobody scans — the checks that moved are the whole
 * reason to look.
 */
export function formatComparison(comparison: RunComparison): string {
  const lines = [
    "",
    `${comparison.taskId} — ${short(comparison.baseline.runId)} → ${short(comparison.candidate.runId)}`,
    `  overall      ${movement(comparison.baseline.score, comparison.candidate.score, comparison.scoreDelta)}`,
  ];

  for (const category of comparison.categories) {
    lines.push(
      `  ${category.category.padEnd(12, " ")} ${movement(
        category.baseline,
        category.candidate,
        category.delta,
      )}  weight ${category.effectiveWeight.toFixed(1)}%`,
    );
  }

  const moved = comparison.checks.filter((check) => check.movement !== "unchanged");
  if (moved.length > 0) {
    lines.push("  checks that moved");
    for (const check of moved) {
      lines.push(
        `    ${MOVEMENT_MARKS[check.movement]} ${check.checkId} — ${check.baseline ?? "—"} → ${
          check.candidate ?? "—"
        } (${check.movement})`,
      );
    }
  }

  const route = describeRoute(comparison.metrics);
  if (route !== null) lines.push(`  route ${route}`);

  if (comparison.sameScoreDifferentRoute) {
    lines.push(
      "",
      "Same score, different route: the two runs agree on the result and disagree on how they",
      "reached it. The trajectories beside the reports are where that difference is legible.",
    );
  }

  for (const side of [comparison.baseline, comparison.candidate]) {
    if (side.errorKind === null) continue;
    lines.push(
      `Note: ${short(side.runId)} errored (${side.errorKind}) and has no score, so anything ` +
        "above that needed one is absent rather than zero.",
    );
  }

  return lines.join("\n");
}

const MOVEMENT_MARKS: Record<CheckMovement, string> = {
  fixed: "✓",
  broken: "✗",
  unchanged: "·",
  added: "+",
  removed: "−",
};

/** `50 → 100 (+50)`, with the sign always shown, because an unsigned delta reads as a total. */
function movement(baseline: number | null, candidate: number | null, delta: number | null): string {
  const from = baseline === null ? "—" : String(baseline);
  const to = candidate === null ? "—" : String(candidate);
  return delta === null ? `${from} → ${to}` : `${from} → ${to} (${signed(delta)})`;
}

function describeRoute(metrics: MetricComparison): string | null {
  const parts: string[] = [];
  const named: [keyof MetricComparison, string][] = [
    ["toolCalls", "tools"],
    ["toolFailures", "tool failures"],
    ["commands", "commands"],
    ["filesChanged", "files"],
    ["inputTokens", "in"],
    ["outputTokens", "out"],
  ];

  for (const [key, label] of named) {
    const figure = metrics[key];
    if (figure === undefined || figure.delta === 0) continue;
    parts.push(`${label} ${figure.baseline} → ${figure.candidate} (${signed(figure.delta)})`);
  }

  return parts.length === 0 ? null : parts.join(" · ");
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/** Run ids are uuids and a comparison names two of them on one line. */
function short(runId: string): string {
  return runId.slice(0, 8);
}
