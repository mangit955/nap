/**
 * Reading what k6 produced, in this repo's vocabulary.
 *
 * The ramp is driven by k6 rather than by the in-process harness, because a hundred users each
 * holding a socket open *and* posting the turn that fills it is what k6's async WebSocket module
 * is for. But its summary is JSON from another program, which makes it a boundary — so it is
 * parsed, not trusted, and mapped onto the same `MetricsRollup` the in-process run produces.
 * One rollup type means one set of threshold code and one report shape for both halves.
 *
 * **Sub-metrics are how a stage is read.** k6 aggregates over the whole run, so the only way to
 * get per-stage figures is to tag each sample with the stage it was taken in and declare a
 * threshold on the tagged sub-metric — declaring it is what makes k6 report it. Their names
 * arrive as `metric{tag:value}`, which is why this file can split one.
 */

import type { Result } from "@nap/shared/result";
import { z } from "zod";
import type { MetricsRollup } from "./metrics.ts";
import type { Summary } from "./percentiles.ts";

/**
 * The trend statistics this repo asks k6 for, via `summaryTrendStats`.
 *
 * `p(99)` and `count` are not in k6's default set, and a p99 is half of what §23's thresholds
 * are stated in — so the k6 script names them and this schema requires them. A summary missing
 * one is a script that was changed without its reader, which should fail loudly here rather
 * than produce a report with holes in it.
 */
const TrendValuesSchema = z.object({
  avg: z.number(),
  min: z.number(),
  med: z.number(),
  max: z.number(),
  count: z.number(),
  "p(95)": z.number(),
  "p(99)": z.number(),
});

const MetricSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("trend"), values: TrendValuesSchema }),
  z.object({ type: z.literal("counter"), values: z.object({ count: z.number() }) }),
  z.object({
    type: z.literal("rate"),
    values: z.object({ rate: z.number(), passes: z.number(), fails: z.number() }),
  }),
  // Reported for `vus` and `vus_max` and read by nothing here, but present in every summary —
  // so it is accepted rather than making a whole run unparseable.
  z.object({ type: z.literal("gauge"), values: z.object({ value: z.number() }) }),
]);

const SummarySchema = z.object({
  metrics: z.record(z.string(), MetricSchema),
});

export type K6Summary = z.infer<typeof SummarySchema>;

export function parseK6Summary(json: unknown): Result<K6Summary, { message: string }> {
  const parsed = SummarySchema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };

  return {
    ok: false,
    error: {
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    },
  };
}

export type MetricName = {
  name: string;
  /** Empty for a plain metric; k6 writes a sub-metric as `name{key:value,key:value}`. */
  tags: Record<string, string>;
};

export function splitMetricName(raw: string): MetricName {
  const open = raw.indexOf("{");
  if (open === -1 || !raw.endsWith("}")) return { name: raw, tags: {} };

  const tags: Record<string, string> = {};
  for (const pair of raw.slice(open + 1, -1).split(",")) {
    const colon = pair.indexOf(":");
    // Split on the *first* colon only: a url tag's value carries several of its own.
    if (colon === -1) continue;
    tags[pair.slice(0, colon).trim()] = pair.slice(colon + 1).trim();
  }

  return { name: raw.slice(0, open), tags };
}

function summaryOf(values: z.infer<typeof TrendValuesSchema>): Summary {
  return {
    count: values.count,
    min: values.min,
    max: values.max,
    mean: values.avg,
    p50: values.med,
    p95: values["p(95)"],
    p99: values["p(99)"],
  };
}

/**
 * The whole-run rollup, or one tag's slice of it.
 *
 * With no `tags` argument this takes only the *untagged* metrics. Including the sub-metrics
 * would count a stage's samples a second time as though they were the whole run — the same
 * numbers, reported twice under two names, which is worse than either alone.
 */
export function rollupOf(summary: K6Summary, tags: Record<string, string> = {}): MetricsRollup {
  const wanted = Object.entries(tags);
  const rollup: MetricsRollup = { trends: {}, counters: {}, rates: {} };

  for (const [raw, metric] of Object.entries(summary.metrics)) {
    const split = splitMetricName(raw);
    const keys = Object.keys(split.tags);
    if (keys.length !== wanted.length) continue;
    if (!wanted.every(([key, value]) => split.tags[key] === value)) continue;

    if (metric.type === "trend") rollup.trends[split.name] = summaryOf(metric.values);
    else if (metric.type === "counter") rollup.counters[split.name] = metric.values.count;
    else if (metric.type === "rate") {
      rollup.rates[split.name] = {
        passed: metric.values.passes,
        total: metric.values.passes + metric.values.fails,
        rate: metric.values.rate,
      };
    }
  }

  return rollup;
}

export type StageRollup = {
  /** The tag's value, as k6 wrote it. */
  label: string;
  /** The same, as a number — the stage's VU target, which is what the report is ordered by. */
  vus: number;
  metrics: MetricsRollup;
};

/**
 * Every stage the run tagged, ascending by VU count.
 *
 * Numerically, not lexicographically: "100" sorts before "25" as a string, and a degradation
 * report read in that order names the wrong stage as the first one to break.
 */
export function stageRollups(summary: K6Summary, tagKey: string): StageRollup[] {
  const labels = new Set<string>();
  for (const raw of Object.keys(summary.metrics)) {
    const label = splitMetricName(raw).tags[tagKey];
    if (label !== undefined) labels.add(label);
  }

  return [...labels]
    .map((label) => ({
      label,
      vus: Number(label),
      metrics: rollupOf(summary, { [tagKey]: label }),
    }))
    .sort((a, b) => a.vus - b.vus);
}
