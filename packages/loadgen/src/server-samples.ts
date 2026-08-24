/**
 * What the process under test looked like while the load ran, stage by stage.
 *
 * k6 measures the system from outside — latencies, failures, what a client saw. It cannot say
 * whether a rising p95 was CPU, the connection pool, or a database doing more work per query,
 * and those are different tickets. So the harness samples the server on a timer and this joins
 * the series to the ramp's stages, which is the join `docs/scaling-design.md` §23 asks for.
 *
 * A window with no samples is kept rather than dropped: a gap in sampling is itself a finding —
 * an event loop too blocked to run a timer is exactly the shape of the failure this run exists
 * to catch — and a report that quietly omitted the stage would read as if it went fine.
 */

import { type Summary, summarize } from "./percentiles.ts";

/** One observation of the server, taken on a timer while the load ran. */
export type ServerSample = {
  /** Epoch milliseconds, so it can be placed against a k6 stage. */
  at: number;
  /** Process CPU over the interval since the previous sample, as a percentage of one core. */
  cpuPercent: number;
  rssBytes: number;
  heapUsedBytes: number;
  /** Backends this database has open, from `pg_stat_activity`. */
  dbConnections: number;
  /** How many of them are running a query right now. */
  dbActiveQueries: number;
  /**
   * A round trip to the database, taken at the same moment.
   *
   * The one thing that separates "the database got slower" from "the process is too busy to
   * read its sockets" — at the client both look like one rising latency, and they are
   * different tickets.
   */
  dbPingMs: number;
  /**
   * The machine's one-minute load average.
   *
   * The load generator runs beside the system under test, so at some VU count the two are
   * competing for the same cores. Without this the report cannot tell "the system stopped
   * scaling" from "the machine ran out", and those are opposite conclusions.
   */
  systemLoad1m: number;
  /** Rows in the event log — the run's own throughput, seen from the other side. */
  eventRows: number;
};

/** A stretch of the run to summarise over, right edge exclusive. */
export type SampleWindow = {
  label: string;
  vus: number;
  from: number;
  to: number;
};

export type WindowRollup = SampleWindow & {
  /** One summary per numeric series, keyed by the sample's field name. */
  series: Partial<Record<Exclude<keyof ServerSample, "at">, Summary>>;
};

const SERIES = [
  "cpuPercent",
  "rssBytes",
  "heapUsedBytes",
  "dbConnections",
  "dbActiveQueries",
  "dbPingMs",
  "systemLoad1m",
  "eventRows",
] as const;

export function rollupSamples(
  samples: readonly ServerSample[],
  windows: readonly SampleWindow[],
): WindowRollup[] {
  return windows.map((window) => {
    const inside = samples.filter((sample) => sample.at >= window.from && sample.at < window.to);
    const series: WindowRollup["series"] = {};

    for (const name of SERIES) {
      const summary = summarize(inside.map((sample) => sample[name]));
      if (summary !== null) series[name] = summary;
    }

    return { ...window, series };
  });
}
