/**
 * What the *cluster* looked like while the load ran, and what moved against a previous run.
 *
 * `server-samples.ts` samples one process: its CPU, its heap, the pool it holds. That is the
 * right shape for the single-process baseline and the wrong one for a deployment — there is no
 * "the process" any more, and the two readings that matter most cannot be taken from inside one:
 * how many pods there are, and how deep the queue is. Both are the subject of
 * `docs/scaling-design.md` §13's autoscalers, and a run that could not see them could not say
 * whether the deployment grew.
 *
 * Pure, and here rather than in the script that collects it, for the reason the rest of this
 * package is: percentile maths and threshold verdicts are testable and `kubectl` is not.
 */

import type { StageRollup } from "./k6-summary.ts";
import { type Summary, summarize } from "./percentiles.ts";
import type { Statistic } from "./report.ts";
import { statisticOf } from "./report.ts";
import type { SampleWindow } from "./server-samples.ts";

/** One observation of the deployment, taken on a timer while the load ran. */
export type ClusterSample = {
  /** Epoch milliseconds, so it can be placed against a k6 stage. */
  at: number;
  /**
   * Ready pods per component — `api`, `worker`, `reaper`.
   *
   * A map rather than three fields, because it is read from labels and a component that scaled
   * to nothing is *absent* rather than zero: `kubectl get pods` returns no rows for it.
   */
  replicas: Record<string, number>;
  /** CPU across every Nap pod, in millicores, as `kubectl top` reports it. */
  podCpuMillicores: number;
  /** Working set across every Nap pod. */
  podMemoryBytes: number;
  /**
   * Open event streams across every API pod — the gauge the HPA scales on, summed.
   *
   * Recorded because a socket count the autoscaler acts on and a socket count nobody checked
   * are different claims, and the run is where the second becomes the first.
   *
   * **`null` when the custom-metrics API answered nothing**, which is a cluster with no
   * prometheus-adapter — and is exactly what that cluster's HPA sees. Collapsing it to zero
   * would put "the autoscaler is blind" and "nobody is connected" under one number, and the
   * first of those invalidates every claim about the API's scaling while the second is a
   * finding about the load.
   */
  wsConnections: number | null;
  /** What the worker autoscaler reads: `turn_requests` by state. */
  queueDepth: { queued: number; leased: number };
  /** Backends the database has open, and how many are running a query. */
  dbConnections: number;
  dbActiveQueries: number;
  /** A round trip to the database, for telling a slow database from a busy client. */
  dbPingMs: number;
  /** The laptop's one-minute load average — k6, Docker and the cluster are all on it. */
  systemLoad1m: number;
  /** Rows in the event log: the run's own throughput, seen from the other side. */
  eventRows: number;
};

/** The numeric series, named once so a new one cannot be added to the type and forgotten here. */
const SERIES = {
  podCpuMillicores: (sample: ClusterSample) => sample.podCpuMillicores,
  podMemoryBytes: (sample: ClusterSample) => sample.podMemoryBytes,
  // The one reader that may answer `null`, which drops the sample from the series rather than
  // averaging a zero into it. A window where the adapter was down therefore has *no*
  // `wsConnections` summary, which is the honest shape: nothing was measured.
  wsConnections: (sample: ClusterSample) => sample.wsConnections,
  queuedRequests: (sample: ClusterSample) => sample.queueDepth.queued,
  leasedRequests: (sample: ClusterSample) => sample.queueDepth.leased,
  dbConnections: (sample: ClusterSample) => sample.dbConnections,
  dbActiveQueries: (sample: ClusterSample) => sample.dbActiveQueries,
  dbPingMs: (sample: ClusterSample) => sample.dbPingMs,
  systemLoad1m: (sample: ClusterSample) => sample.systemLoad1m,
  eventRows: (sample: ClusterSample) => sample.eventRows,
} as const;

export type ClusterSeriesName = keyof typeof SERIES;

export type ClusterWindowRollup = SampleWindow & {
  series: Partial<Record<ClusterSeriesName, Summary>>;
  /**
   * The range each component's replica count moved through in this window.
   *
   * A range rather than a mean, because the whole question is whether the autoscaler *acted*:
   * a deployment that went from two pods to six and back averages the same as one that never
   * moved, and only one of those is scaling.
   */
  replicas: Record<string, { min: number; max: number }>;
};

export function rollupClusterSamples(
  samples: readonly ClusterSample[],
  windows: readonly SampleWindow[],
): ClusterWindowRollup[] {
  return windows.map((window) => {
    const inside = samples.filter((sample) => sample.at >= window.from && sample.at < window.to);

    const series: ClusterWindowRollup["series"] = {};
    for (const [name, read] of Object.entries(SERIES) as [
      ClusterSeriesName,
      (sample: ClusterSample) => number | null,
    ][]) {
      const summary = summarize(
        inside.map(read).filter((value): value is number => value !== null),
      );
      if (summary !== null) series[name] = summary;
    }

    const replicas: ClusterWindowRollup["replicas"] = {};
    for (const sample of inside) {
      for (const [component, count] of Object.entries(sample.replicas)) {
        const seen = replicas[component];
        replicas[component] =
          seen === undefined
            ? { min: count, max: count }
            : { min: Math.min(seen.min, count), max: Math.max(seen.max, count) };
      }
    }

    return { ...window, series, replicas };
  });
}

/** One number to line up between two runs. */
export type ComparedMetric = { metric: string; statistic: Statistic };

export type StageComparison = {
  vus: number;
  metric: string;
  statistic: Statistic;
  /** `null` when the baseline run never reached this stage, or never recorded the metric. */
  baseline: number | null;
  candidate: number | null;
  /**
   * candidate ÷ baseline, so below 1 is an improvement.
   *
   * `null` when either side is missing *or* the baseline is zero — a ratio against zero is
   * infinity, which formats as a headline nobody should quote.
   */
  ratio: number | null;
};

/**
 * What moved between two finished runs, stage by stage.
 *
 * Paired on VU count rather than on position: the two runs may have different profiles, and
 * comparing the third stage of one against the third of the other is how a 50-user plateau ends
 * up quoted against a 75-user one. A stage only one run reached is reported with the other side
 * `null`, because a row missing from a comparison is how a stage nobody looked at gets quoted.
 */
export function compareStages(
  baseline: readonly StageRollup[],
  candidate: readonly StageRollup[],
  metrics: readonly ComparedMetric[],
): StageComparison[] {
  const vus = [...new Set([...baseline, ...candidate].map((stage) => stage.vus))].sort(
    (a, b) => a - b,
  );

  const comparisons: StageComparison[] = [];
  for (const count of vus) {
    const before = baseline.find((stage) => stage.vus === count);
    const after = candidate.find((stage) => stage.vus === count);

    for (const { metric, statistic } of metrics) {
      const baselineValue =
        before === undefined ? null : (statisticOf(before.metrics, metric, statistic) ?? null);
      const candidateValue =
        after === undefined ? null : (statisticOf(after.metrics, metric, statistic) ?? null);

      comparisons.push({
        vus: count,
        metric,
        statistic,
        baseline: baselineValue,
        candidate: candidateValue,
        ratio:
          baselineValue === null || candidateValue === null || baselineValue === 0
            ? null
            : candidateValue / baselineValue,
      });
    }
  }

  return comparisons;
}
