/**
 * What a load run records while it runs, and what it rolls up to at the end.
 *
 * Three kinds, deliberately the same three k6 has — a `Trend` for anything measured in
 * milliseconds, a `Counter` for anything that must be zero, a `Rate` for anything that must be
 * nearly one — because `docs/scaling-design.md` §23 states the thresholds in k6's vocabulary
 * and the two halves of the harness must be readable against one list.
 *
 * A rate keeps its numerator and denominator rather than a running quotient. "0.98" says
 * nothing about whether two users in a hundred failed or one in fifty; the second is a smaller
 * sample and a much weaker claim, and only the pair can tell them apart.
 */

import { type Summary, summarize } from "./percentiles.ts";

export type RateSummary = { passed: number; total: number; rate: number };

export type MetricsRollup = {
  /** Only metrics with at least one sample appear — `summarize` has nothing to say otherwise. */
  trends: Record<string, Summary>;
  counters: Record<string, number>;
  rates: Record<string, RateSummary>;
};

export class Metrics {
  readonly #trends = new Map<string, number[]>();
  readonly #counters = new Map<string, number>();
  readonly #rates = new Map<string, { passed: number; total: number }>();

  /** One observation of something measured — a latency, a duration, an inter-arrival gap. */
  trend(name: string, value: number): void {
    const samples = this.#trends.get(name);
    if (samples === undefined) this.#trends.set(name, [value]);
    else samples.push(value);
  }

  count(name: string, by = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }

  /**
   * Registers a counter at zero.
   *
   * The counters that matter most here are the ones a healthy run never touches — seq gaps,
   * duplicates, refused connections. A report that simply omits them is indistinguishable from
   * one produced by a harness that forgot to check, so the run declares them up front and the
   * zero is printed as a result rather than as an absence.
   */
  declareCounter(name: string): void {
    if (!this.#counters.has(name)) this.#counters.set(name, 0);
  }

  rate(name: string, ok: boolean): void {
    const current = this.#rates.get(name) ?? { passed: 0, total: 0 };
    this.#rates.set(name, { passed: current.passed + (ok ? 1 : 0), total: current.total + 1 });
  }

  rollup(): MetricsRollup {
    const trends: Record<string, Summary> = {};
    for (const [name, samples] of this.#trends) {
      const summary = summarize(samples);
      if (summary !== null) trends[name] = summary;
    }

    const rates: Record<string, RateSummary> = {};
    for (const [name, { passed, total }] of this.#rates) {
      rates[name] = { passed, total, rate: total === 0 ? 0 : passed / total };
    }

    return { trends, counters: Object.fromEntries(this.#counters), rates };
  }
}
