/**
 * `docs/scaling-design.md` §23's thresholds and degradation rules, in one place.
 *
 * They belong to the design rather than to any script, and two runs are compared against each
 * other only if they were judged by the same numbers — so the single-process baseline
 * (`loadgen-ramp.ts`) and the cluster run (`loadgen-cluster.ts`) read them from here. Two copies
 * were the first shape, and the second one was already a comment apologising for the first.
 *
 * **Not `loadgen.ts`'s.** The in-process scripted-user harness has its own, deliberately: it runs
 * a handful of users through the composition to check the journey works, and holding it to a
 * hundred-user ramp's percentiles would fail it for being small.
 */

import type { DegradationRule } from "./degradation.ts";
import type { Threshold } from "./report.ts";

/**
 * What counts as the system getting materially worse, stage over stage.
 *
 * Each trend rule carries a floor as well as a multiple, because a fourfold rise from two
 * milliseconds is not a finding — see `./degradation.ts`. The counters and rates need neither: a
 * dropped event or a turn that never finished is degradation at any scale.
 */
export const RAMP_DEGRADATION: readonly DegradationRule[] = [
  { kind: "counter", metric: "event_seq_gaps", maxValue: 0 },
  { kind: "counter", metric: "event_duplicates", maxValue: 0 },
  { kind: "counter", metric: "ws_connect_failures", maxValue: 0 },
  { kind: "counter", metric: "errors_5xx", maxValue: 0 },
  { kind: "counter", metric: "errors_timeout", maxValue: 0 },
  { kind: "rate", metric: "turn_completion_rate", minValue: 0.99 },
  { kind: "rate", metric: "job_completion_rate", minValue: 0.99 },
  { kind: "rate", metric: "verification_completion_rate", minValue: 0.99 },
  // Admission is the route's own work — the rate-limit and quota queries and the write that
  // accepts the turn — and the one latency a fake-backed run measures honestly.
  {
    kind: "trend",
    metric: "admission_latency",
    statistic: "p95",
    multipleOfBaseline: 3,
    floor: 100,
  },
  // How long a turn waited before anything ran it. The queue's own depth, felt by a person.
  { kind: "trend", metric: "queue_wait", statistic: "p95", multipleOfBaseline: 3, floor: 2_000 },
  {
    kind: "trend",
    metric: "time_to_first_event",
    statistic: "p95",
    multipleOfBaseline: 3,
    floor: 1_000,
  },
  // Append to delivery. This is fanout, and it is the number the whole scaling design is about.
  {
    kind: "trend",
    metric: "event_delivery_latency",
    statistic: "p95",
    multipleOfBaseline: 3,
    floor: 500,
  },
];

/** §23's thresholds on the whole run's untagged metrics. */
export const RAMP_THRESHOLDS: readonly Threshold[] = [
  { metric: "ws_connect_failures", statistic: "count", op: "==", value: 0 },
  { metric: "event_seq_gaps", statistic: "count", op: "==", value: 0 },
  { metric: "event_duplicates", statistic: "count", op: "==", value: 0 },
  { metric: "reconnect_seq_gaps", statistic: "count", op: "==", value: 0 },
  { metric: "reconnect_duplicates", statistic: "count", op: "==", value: 0 },
  { metric: "turn_completion_rate", statistic: "rate", op: ">", value: 0.99 },
  { metric: "verification_completion_rate", statistic: "rate", op: ">", value: 0.99 },
  { metric: "admission_latency", statistic: "p95", op: "<", value: 300 },
  { metric: "queue_wait", statistic: "p95", op: "<", value: 5_000 },
  { metric: "time_to_first_event", statistic: "p95", op: "<", value: 2_000 },
  { metric: "event_delivery_latency", statistic: "p95", op: "<", value: 1_000 },
  { metric: "http_req_failed", statistic: "rate", op: "<", value: 0.01 },
  { metric: "dropped_iterations", statistic: "count", op: "==", value: 0 },
];

/**
 * §23's two thresholds on the submission request itself.
 *
 * Separate because they are stated on a *tagged* sub-metric —
 * `http_req_duration{name:submit_turn}` — and the untagged rollup deliberately leaves those out,
 * or one stage's samples would be counted a second time as though they were the whole run.
 */
export const RAMP_SUBMIT_THRESHOLDS: readonly Threshold[] = [
  { metric: "http_req_duration", statistic: "p95", op: "<", value: 500 },
  { metric: "http_req_duration", statistic: "p99", op: "<", value: 1_500 },
];
