/**
 * Where the system first got materially worse.
 *
 * `docs/scaling-design.md` §23 is blunt about this: *the first point of material degradation is
 * the headline result, and the run is not a success unless it is found.* A run that passed every
 * threshold has answered a different, much weaker question — whether the ceiling is above the
 * numbers somebody wrote down beforehand — and the ticket that needs answering is where the
 * ceiling actually is.
 *
 * Two words are doing the work, and both are decisions rather than maths:
 *
 *   - **first.** Stages are compared against the *first* one, not against the previous. Against
 *     the previous, a system degrading smoothly by 30% a stage never trips anything, and the
 *     tenfold total goes unreported.
 *   - **material.** A multiple alone is not enough. Two milliseconds becoming eight is a
 *     fourfold rise nobody can feel, and a report calling that the breaking point sends the next
 *     person to optimise something that was never a problem — so every trend rule carries an
 *     absolute floor as well.
 */

import type { MetricsRollup } from "./metrics.ts";
import type { Statistic } from "./report.ts";

export type StageObservation = {
  label: string;
  vus: number;
  metrics: MetricsRollup;
};

export type DegradationRule =
  /** A latency that has both multiplied past the baseline and crossed a floor worth noticing. */
  | {
      kind: "trend";
      metric: string;
      statistic: Exclude<Statistic, "rate">;
      multipleOfBaseline: number;
      /** Below this, the metric is fast enough that a multiple of it means nothing. */
      floor: number;
    }
  /** Something that must stay at or below a value — gaps, duplicates, errors. */
  | { kind: "counter"; metric: string; maxValue: number }
  /** Something that must stay at or above one — turns finishing, verifications running. */
  | { kind: "rate"; metric: string; minValue: number };

export type Degradation = {
  label: string;
  vus: number;
  /** One line per rule that tripped, in the order the rules were given. */
  reasons: string[];
};

function round(value: number): string {
  return Math.abs(value) >= 10 ? String(Math.round(value)) : value.toFixed(2);
}

function reasonFor(
  rule: DegradationRule,
  baseline: MetricsRollup,
  stage: MetricsRollup,
): string | null {
  if (rule.kind === "counter") {
    const observed = stage.counters[rule.metric];
    // Absent is not evidence: a counter only appears in a stage that touched it.
    if (observed === undefined || observed <= rule.maxValue) return null;
    return `${rule.metric} reached ${observed}, above its ceiling of ${rule.maxValue}`;
  }

  if (rule.kind === "rate") {
    const observed = stage.rates[rule.metric];
    if (observed === undefined || observed.rate >= rule.minValue) return null;
    return `${rule.metric} fell to ${(observed.rate * 100).toFixed(1)}% (${observed.passed}/${observed.total}), below ${rule.minValue}`;
  }

  const before = baseline.trends[rule.metric];
  const after = stage.trends[rule.metric];
  if (before === undefined || after === undefined) return null;

  const from = before[rule.statistic];
  const to = after[rule.statistic];
  if (to < rule.floor) return null;
  if (from > 0 && to < from * rule.multipleOfBaseline) return null;
  // A baseline of zero cannot be multiplied, so the floor is the whole test there.
  if (from === 0 && to < rule.floor) return null;

  return `${rule.metric}.${rule.statistic} rose from ${round(from)} to ${round(to)}, past ${rule.multipleOfBaseline}× the baseline and the ${rule.floor} floor`;
}

/**
 * @param stages Every stage of the ramp, ascending. The first is the yardstick and is never
 *   itself reported — it cannot be a multiple of itself, and a rule that let it degrade would
 *   report "the system broke at the lightest load" on every run.
 * @returns The first stage that tripped any rule, with every reason it tripped, or `null` when
 *   the ramp finished without finding one — which means the ramp did not go far enough.
 */
export function firstDegradation(
  stages: readonly StageObservation[],
  rules: readonly DegradationRule[],
): Degradation | null {
  const baseline = stages[0];
  if (baseline === undefined) return null;

  for (const stage of stages.slice(1)) {
    const reasons = rules
      .map((rule) => reasonFor(rule, baseline.metrics, stage.metrics))
      .filter((reason): reason is string => reason !== null);

    if (reasons.length > 0) return { label: stage.label, vus: stage.vus, reasons };
  }

  return null;
}
