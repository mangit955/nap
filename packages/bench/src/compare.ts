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
 * **The refusals do not all guard the same thing**, which is why they are separate functions
 * asked in a fixed order. A mismatched weight vector corrupts the *arithmetic*, so it is
 * skipped when neither run has a number to reprice. A mismatched turn budget corrupts the
 * *attribution* — `budget_exceeded` counts against the agent only while the ceiling is held
 * fixed — so it applies to unscored runs too, which is exactly where an error kind is the whole
 * finding. See docs/adr/0004.
 *
 * Two runs, and exactly two. Comparing three is a different tool with a different shape — a
 * table rather than a diff — and is explicitly out of scope for v1.
 */

import type { Result } from "@nap/shared/result";
import type { CheckOutcome } from "@nap/verify/check-outcome";
import { CATEGORIES, type Category } from "./category.ts";
import type { ErrorKind } from "./error-kind.ts";
import type { RunMetrics } from "./metrics.ts";
import type { BenchReport } from "./report.ts";
import { budgetsDiffer, describeTurnBudget } from "./run-configuration.ts";
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
  /** Null when that side did not score this category at all, which only an unscored run does. */
  baseline: number | null;
  candidate: number | null;
  /** Null whenever either side is, since a delta from nothing is not a delta. */
  delta: number | null;
  /** Shared by both sides when both scored it — a differing vector is refused before this. */
  effectiveWeight: number;
};

/**
 * What happened to one check.
 *
 * *Added* and *removed* are kept rather than dropped: a check that exists on one side only is
 * usually the task having changed underneath the comparison, which is the most important thing
 * a reader can be told and the easiest to hide by quietly intersecting the two lists.
 */
export type CheckMovement = "fixed" | "broken" | "changed" | "unchanged" | "added" | "removed";

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

  // Asked before the weights, because it is the wider refusal: this one applies to unscored
  // runs too, and a run with no score has no effective vector for the next check to look at.
  const budget = budgetRefusal(baseline, candidate);
  if (budget !== null) return { ok: false, error: budget };

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
 * Why these two runs were not held at the same ceiling, or null if they were.
 *
 * The guard that keeps `budget_exceeded` honestly attributed to the agent. That attribution
 * rests on the budget being one of the things held fixed (docs/adr/0004); across two different
 * ceilings, "this model ran out" is a property of a setting wearing the costume of a property
 * of a model.
 *
 * **Deliberately not skipped for unscored runs**, which is where it parts company with the
 * weights refusal below. That one skips them because there is no number to reprice. This one
 * must not, because what a budget mismatch corrupts is the *attribution* rather than the
 * arithmetic — and an errored run is precisely where the attribution is the entire finding.
 *
 * Nothing is refused on an unknown: see `budgetsDiffer`, which folds "cannot tell" in with
 * "same" so the archive stays readable.
 */
function budgetRefusal(baseline: BenchReport, candidate: BenchReport): string | null {
  if (!budgetsDiffer(baseline.configuration.budget, candidate.configuration.budget)) return null;

  return (
    "these runs were held at different turn budgets — " +
    `${describeTurnBudget(baseline.configuration.budget)} and ` +
    `${describeTurnBudget(candidate.configuration.budget)}. A budget is one of the things a ` +
    "comparison holds fixed, and an agent that exhausted the smaller one is not evidence " +
    "about the model."
  );
}

/**
 * Why these two runs may not be subtracted, or null if they may.
 *
 * The *effective* vector decides, and the configured one deliberately does not. They answer
 * different questions, and only the first is about whether two numbers are on one scale:
 * reweighting a category that neither run scored changes the configuration and renormalises to
 * exactly the same effective vector, so those two runs are comparable and refusing them would
 * be strictness bought with a false reason. A configured change that *did* move the scale shows
 * up here anyway, because it moved the effective vector. ADR-0002 names this one for the same
 * reason.
 *
 * Skipped entirely when either run has no score. There is nothing to reprice on a run that
 * produced no number, and refusing there would make an errored run incomparable with anything —
 * which is precisely when somebody most wants to see what the other side did.
 */
function weightsRefusal(baseline: BenchReport, candidate: BenchReport): string | null {
  if (!carriesScore(baseline.status) || !carriesScore(candidate.status)) return null;
  if (sameEffectiveVector(baseline, candidate)) return null;

  return (
    `these runs have different effective weight vectors — ${effectiveVector(baseline)} and ` +
    `${effectiveVector(candidate)}. An absent category renormalises the rest, so the two ` +
    "scores are on different scales and the difference between them is not a measurement."
  );
}

/**
 * Whether the two runs were scored over the same categories at the same shares.
 *
 * Compared structurally rather than by formatting both and matching the strings: rounding to a
 * decimal place would call two vectors equal that are not, and matching formatted text would
 * make the *order* the report happened to list its categories in load-bearing for a refusal
 * this whole module exists to get right.
 */
function sameEffectiveVector(baseline: BenchReport, candidate: BenchReport): boolean {
  if (baseline.categories.length !== candidate.categories.length) return false;

  const after = new Map(
    candidate.categories.map((entry) => [entry.category, entry.effectiveWeight]),
  );
  return baseline.categories.every((entry) => after.get(entry.category) === entry.effectiveWeight);
}

/** The effective vector as one readable string. For the message only; nothing decides on it. */
function effectiveVector(report: BenchReport): string {
  if (report.categories.length === 0) return "none";
  return report.categories
    .map((entry) => `${entry.category} ${entry.effectiveWeight.toFixed(1)}%`)
    .join(", ");
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
 * Every category either run scored, in the canonical order reports are built in.
 *
 * A union rather than an intersection, and the case that makes the difference is an unscored
 * run: it has no categories at all, so intersecting would erase the *other* side's whole
 * breakdown — which is precisely what somebody comparing against an errored run is looking at.
 * Two scored runs always agree on the set, because a differing one was refused above.
 */
function compareCategories(baseline: BenchReport, candidate: BenchReport): CategoryDelta[] {
  const before = new Map(baseline.categories.map((entry) => [entry.category, entry]));
  const after = new Map(candidate.categories.map((entry) => [entry.category, entry]));

  return CATEGORIES.flatMap((category) => {
    const left = before.get(category);
    const right = after.get(category);
    if (left === undefined && right === undefined) return [];

    return [
      {
        category,
        baseline: left?.score ?? null,
        candidate: right?.score ?? null,
        delta: left === undefined || right === undefined ? null : right.score - left.score,
        // Equal on both sides whenever both are present, and whichever one exists otherwise.
        effectiveWeight: left?.effectiveWeight ?? right?.effectiveWeight ?? 0,
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
 * `absent` is neither fixed nor broken in either direction: it means the run never asked, which
 * is a fact about the circumstances rather than about the agent, and calling passed-to-absent a
 * regression would undo the distinction the whole scoring model rests on.
 *
 * But it is not *nothing* either, which is the mistake this used to make. An absent check
 * renormalises its category out of the weighting and moves the overall score (ADR-0002), so
 * recording it as unchanged hands a reader a number that moved with no check to explain it.
 * Hence `changed`: something happened here, and it was not the agent getting better or worse.
 */
function movementOf(baseline: CheckOutcome | null, candidate: CheckOutcome | null): CheckMovement {
  if (candidate === null) return "removed";
  if (baseline === null) return "added";
  if (baseline === candidate) return "unchanged";
  if (baseline === "failed" && candidate === "passed") return "fixed";
  if (baseline === "passed" && candidate === "failed") return "broken";
  return "changed";
}

/**
 * Every figure a comparison carries, described once.
 *
 * One table rather than three lists, because they used to be three — the type, the fold that
 * built it, the set that decided "different route" and the list that printed it — and a figure
 * added to one and forgotten in another is exactly how `turnDurationMs` came to be computed on
 * every comparison and displayed on none.
 */
type MetricField = {
  key: keyof MetricComparison;
  label: string;
  read: (metrics: RunMetrics) => number | undefined;
  /**
   * Whether a difference here means the two runs *did* different things.
   *
   * False for time and tokens. Both vary between two runs that did exactly the same work — a
   * millisecond either way, a few tokens of sampling difference — so a "different route" claim
   * resting on them would fire on every pair, which is how a signal becomes noise. They are
   * still reported; they just do not decide.
   */
  shape: boolean;
  format?: (value: number) => string;
};

const seconds = (value: number): string => `${(value / 1000).toFixed(1)}s`;

const METRIC_FIELDS: readonly MetricField[] = [
  { key: "toolCalls", label: "tools", read: (m) => m.toolCalls, shape: true },
  { key: "toolFailures", label: "tool failures", read: (m) => m.toolFailures, shape: true },
  { key: "commands", label: "commands", read: (m) => m.commands, shape: true },
  { key: "filesChanged", label: "files", read: (m) => m.filesChanged, shape: true },
  { key: "inputTokens", label: "in", read: (m) => m.tokens?.inputTokens, shape: false },
  { key: "outputTokens", label: "out", read: (m) => m.tokens?.outputTokens, shape: false },
  {
    key: "turnDurationMs",
    label: "turn time",
    read: (m) => m.turnDurationMs,
    shape: false,
    format: seconds,
  },
];

/**
 * Each figure, present only when both runs measured it.
 *
 * A figure one side is missing is dropped rather than defaulted to zero: the absent side did
 * not measure nothing, it measured nothing *measurable*, and a delta against a stand-in zero
 * would read as a change the runs never made.
 */
function compareMetrics(baseline: BenchReport, candidate: BenchReport): MetricComparison {
  const comparison: MetricComparison = {};

  for (const field of METRIC_FIELDS) {
    const before = field.read(baseline.metrics);
    const after = field.read(candidate.metrics);
    if (before === undefined || after === undefined) continue;

    comparison[field.key] = { baseline: before, candidate: after, delta: after - before };
  }

  return comparison;
}

/** Whether the two runs did different things, as opposed to taking different lengths of time. */
function routeDiffers(metrics: MetricComparison): boolean {
  return METRIC_FIELDS.filter((field) => field.shape).some(
    (field) => (metrics[field.key]?.delta ?? 0) !== 0,
  );
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
    `  overall      ${arrow(comparison.baseline.score, comparison.candidate.score, comparison.scoreDelta)}`,
  ];

  for (const category of comparison.categories) {
    lines.push(
      `  ${category.category.padEnd(12, " ")} ${arrow(
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
  changed: "~",
  unchanged: "·",
  added: "+",
  removed: "−",
};

/** `50 → 100 (+50)`, with the sign always shown, because an unsigned delta reads as a total. */
function arrow(baseline: number | null, candidate: number | null, delta: number | null): string {
  const from = baseline === null ? "—" : String(baseline);
  const to = candidate === null ? "—" : String(candidate);
  return delta === null ? `${from} → ${to}` : `${from} → ${to} (${signed(delta)})`;
}

function describeRoute(metrics: MetricComparison): string | null {
  const parts: string[] = [];

  for (const field of METRIC_FIELDS) {
    const figure = metrics[field.key];
    if (figure === undefined || figure.delta === 0) continue;

    const show = field.format ?? String;
    parts.push(
      `${field.label} ${show(figure.baseline)} → ${show(figure.candidate)} (${signed(figure.delta, field.format)})`,
    );
  }

  return parts.length === 0 ? null : parts.join(" · ");
}

function signed(value: number, format: ((value: number) => string) | undefined = String): string {
  return value > 0 ? `+${format(value)}` : format(value);
}

/** Run ids are uuids and a comparison names two of them on one line. */
function short(runId: string): string {
  return runId.slice(0, 8);
}
