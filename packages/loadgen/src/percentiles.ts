/**
 * The distribution maths every load report is read through.
 *
 * A load test's headline is never a mean — it is "the slowest one in twenty", because that is
 * the request somebody actually waited on. So this is the part of the harness most worth having
 * tested rather than trusted: a p95 computed with an off-by-one rank is wrong by exactly the
 * amount that matters, it looks entirely plausible in a report, and nothing downstream can
 * notice. It is pure and takes plain numbers, so it costs nothing to check.
 *
 * **Nearest rank**, not interpolation: the value returned is one that was really observed. An
 * interpolated p95 is a latency no request had, which is a poor thing to put a threshold on.
 */

export type Summary = {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
};

/**
 * The `p`th percentile of `values`, by nearest rank.
 *
 * Both refusals are programmer error rather than an expected outcome — an empty sample means
 * the caller asked about a metric nothing recorded — so they throw rather than returning a
 * result object. `summarize` is the total function to reach for when emptiness is ordinary.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new RangeError("cannot take a percentile of no samples");
  if (p <= 0 || p > 100) throw new RangeError(`percentile must be between 0 and 100, got ${p}`);

  // Copied before sorting: the caller's array is theirs, and a recorder handing out its own
  // storage would otherwise find its samples reordered by having been read.
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);

  // `rank` is at least 1 for any p above zero, and at most the length, so the index is in range.
  return sorted[rank - 1] as number;
}

/** Every statistic a report shows for one metric, or `null` when nothing was recorded. */
export function summarize(values: readonly number[]): Summary | null {
  if (values.length === 0) return null;

  const total = values.reduce((sum, value) => sum + value, 0);

  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: total / values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
  };
}
