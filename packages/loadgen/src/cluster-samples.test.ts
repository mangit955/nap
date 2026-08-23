import { describe, expect, it } from "vitest";
import { type ClusterSample, compareStages, rollupClusterSamples } from "./cluster-samples.ts";
import type { StageRollup } from "./k6-summary.ts";

function sample(overrides: Partial<ClusterSample> & { at: number }): ClusterSample {
  return {
    replicas: { api: 3, worker: 2, reaper: 1 },
    podCpuMillicores: 0,
    podMemoryBytes: 0,
    wsConnections: 0,
    queueDepth: { queued: 0, leased: 0 },
    dbConnections: 0,
    dbActiveQueries: 0,
    dbPingMs: 0,
    systemLoad1m: 0,
    eventRows: 0,
    ...overrides,
  };
}

describe("rollupClusterSamples", () => {
  it("summarises each numeric series inside a window", () => {
    const rollup = rollupClusterSamples(
      [
        sample({ at: 10, podCpuMillicores: 100 }),
        sample({ at: 20, podCpuMillicores: 300 }),
        // Outside, so it must not move the maximum.
        sample({ at: 99, podCpuMillicores: 9_000 }),
      ],
      [{ label: "50", vus: 50, from: 0, to: 50 }],
    );

    expect(rollup[0]?.series.podCpuMillicores).toMatchObject({ count: 2, max: 300 });
  });

  it("reports the replica range each component moved through", () => {
    // The number the whole ticket turns on: an autoscaler that never moved and one that moved
    // and came back look identical in a mean, and only one of them is the deployment scaling.
    const rollup = rollupClusterSamples(
      [
        sample({ at: 10, replicas: { api: 3, worker: 2 } }),
        sample({ at: 20, replicas: { api: 5, worker: 4 } }),
        sample({ at: 30, replicas: { api: 4, worker: 4 } }),
      ],
      [{ label: "100", vus: 100, from: 0, to: 50 }],
    );

    expect(rollup[0]?.replicas).toEqual({
      api: { min: 3, max: 5 },
      worker: { min: 2, max: 4 },
    });
  });

  it("leaves the socket gauge out entirely when the adapter answered nothing", () => {
    // Not a zero. A cluster whose prometheus-adapter is down is blind, not empty, and the two
    // readings support opposite conclusions about whether the API's autoscaler could have acted.
    const rollup = rollupClusterSamples(
      [sample({ at: 10, wsConnections: null }), sample({ at: 20, wsConnections: null })],
      [{ label: "100", vus: 100, from: 0, to: 50 }],
    );

    expect(rollup[0]?.series.wsConnections).toBeUndefined();
  });

  it("summarises only the samples the gauge answered", () => {
    const rollup = rollupClusterSamples(
      [
        sample({ at: 10, wsConnections: null }),
        sample({ at: 20, wsConnections: 40 }),
        sample({ at: 30, wsConnections: 60 }),
      ],
      [{ label: "100", vus: 100, from: 0, to: 50 }],
    );

    // Two, not three: a missing reading must not be averaged in as nobody connected.
    expect(rollup[0]?.series.wsConnections).toMatchObject({ count: 2, min: 40, max: 60 });
  });

  it("keeps a window nothing was sampled in", () => {
    // A gap in sampling is itself a finding — the same argument `rollupSamples` makes. A report
    // that dropped the stage would read as though it had gone fine.
    const rollup = rollupClusterSamples([], [{ label: "10", vus: 10, from: 0, to: 50 }]);

    expect(rollup).toHaveLength(1);
    expect(rollup[0]?.series.podCpuMillicores).toBeUndefined();
    expect(rollup[0]?.replicas).toEqual({});
  });

  it("ignores a component that appears only in some samples", () => {
    // A worker scaled to zero replicas is absent from `kubectl get`, not present as a zero. The
    // range still has to include the samples that did see it.
    const rollup = rollupClusterSamples(
      [sample({ at: 10, replicas: { worker: 2 } }), sample({ at: 20, replicas: {} })],
      [{ label: "10", vus: 10, from: 0, to: 50 }],
    );

    expect(rollup[0]?.replicas).toEqual({ worker: { min: 2, max: 2 } });
  });
});

function stage(vus: number, p95: number): StageRollup {
  return {
    label: String(vus),
    vus,
    metrics: {
      trends: {
        admission_latency: { count: 1, min: p95, max: p95, mean: p95, p50: p95, p95, p99: p95 },
      },
      counters: {},
      rates: {},
    },
  };
}

describe("compareStages", () => {
  it("pairs stages by VU count and names the change", () => {
    const compared = compareStages(
      [stage(100, 200)],
      [stage(100, 50)],
      [{ metric: "admission_latency", statistic: "p95" }],
    );

    expect(compared).toEqual([
      {
        vus: 100,
        metric: "admission_latency",
        statistic: "p95",
        baseline: 200,
        candidate: 50,
        ratio: 0.25,
      },
    ]);
  });

  it("reports a stage the baseline never reached, rather than skipping it", () => {
    // The candidate is allowed to go further than the run it is compared against, and a row
    // silently missing from the comparison is how a stage nobody looked at gets quoted anyway.
    const compared = compareStages(
      [],
      [stage(400, 50)],
      [{ metric: "admission_latency", statistic: "p95" }],
    );

    expect(compared[0]).toMatchObject({ vus: 400, baseline: null, ratio: null, candidate: 50 });
  });

  it("does not divide by a baseline of zero", () => {
    const compared = compareStages(
      [stage(100, 0)],
      [stage(100, 5)],
      [{ metric: "admission_latency", statistic: "p95" }],
    );

    expect(compared[0]?.ratio).toBeNull();
  });
});
