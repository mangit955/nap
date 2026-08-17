/**
 * What a run cost, as an estimate that says so.
 *
 * The event log records tokens, not money — nothing in Nap sees a bill — so a cost figure is
 * derived by multiplying counts by a price somebody typed in. That is useful and it is not a
 * measurement, and the difference has to survive being read a year later by somebody who was
 * not here: hence a **versioned** table, a figure that carries the version and the model that
 * produced it, and a name that says "estimate" wherever it appears.
 *
 * **A model with no entry gets no number.** Guessing a price from a similar model would put a
 * confident, wrong figure in an archived report, which is worse than a gap — see ADR-0003 on
 * why absent beats inferred throughout NapBench.
 */

import { z } from "zod";
// Type-only, so the two modules can name each other without a runtime cycle: tokens are
// counted in `metrics.ts` and priced here, and one schema defines the shape for both.
import type { TokenUsage } from "./metrics.ts";

/**
 * Bumped whenever a price changes, and recorded in every estimate.
 *
 * Prices move, and a comparison between a report from today and one from six months ago is a
 * comparison of two tables unless the reader can see they were the same. Dated rather than
 * numbered so the version answers "when was this true" without a changelog.
 */
export const PRICE_TABLE_VERSION = "2026-08-17";

export const ModelPriceSchema = z.strictObject({
  inputPerMTokUsd: z.number().nonnegative(),
  outputPerMTokUsd: z.number().nonnegative(),
});

export type ModelPrice = z.infer<typeof ModelPriceSchema>;

/**
 * Per-million-token prices, by the model id this repository spells models with.
 *
 * Only the models Nap actually runs on. A table of everything OpenRouter offers would be
 * a maintenance burden whose entries were never checked against a bill, and the failure mode
 * of a stale price nobody uses is that somebody eventually does.
 */
export const MODEL_PRICES = {
  // The debug model, from the figures recorded in PROGRESS.md when the harness was costed.
  "openai/gpt-5.6-luna": { inputPerMTokUsd: 0.1, outputPerMTokUsd: 0.6 },
  // The measurement model: strong enough to attempt the hard suite, cheap enough to run six
  // times. Read from OpenRouter's own model listing on the date in the version below, which
  // is the rate the before/after arms were actually billed at.
  "openai/gpt-5.6-terra": { inputPerMTokUsd: 1, outputPerMTokUsd: 6 },
  // The demo model. Anthropic's published first-party rate; OpenRouter's own margin on top
  // is not modelled, which is one more reason the figure is called an estimate.
  "anthropic/claude-opus-5": { inputPerMTokUsd: 5, outputPerMTokUsd: 25 },
} as const satisfies Record<string, ModelPrice>;

export const CostEstimateSchema = z.strictObject({
  /** Rounded to the cent-thousandth: a benchmark turn costs fractions of a cent. */
  usd: z.number().nonnegative(),
  /**
   * Which model was priced, since the same token counts cost fifty times more on one.
   *
   * The model the run *asked* for. Nothing in the event log records which model answered,
   * so a provider-side fallback would be priced at the requested model's rate — one more
   * reason the figure is an estimate, and one the log would have to change to fix.
   */
  model: z.string().min(1),
  /** Which table produced it, so an old report is not silently repriced by a new one. */
  priceTableVersion: z.string().min(1),
});

export type CostEstimate = z.infer<typeof CostEstimateSchema>;

/**
 * Prices a token count, or returns undefined when it cannot be priced honestly.
 *
 * Two ways to get nothing back, and both are the point: no model was recorded, or the model
 * is not in the table. Cache reads are not modelled either — the provider reports them and
 * the event log does not carry them, so a cached turn is over-estimated. Stated here because
 * a number that is quietly wrong in one direction is worse than one nobody trusts.
 */
export function estimateCost(
  model: string | undefined,
  usage: TokenUsage | undefined,
): CostEstimate | undefined {
  if (model === undefined || usage === undefined) return undefined;

  // `Object.hasOwn` rather than a plain lookup: `MODEL_PRICES.toString` is a function, and
  // an index signature would hand it back as a price and turn the estimate into NaN. A
  // model id arrives from a CLI flag, so "a model named like an Object method" is reachable.
  if (!Object.hasOwn(MODEL_PRICES, model)) return undefined;
  const price = (MODEL_PRICES as Record<string, ModelPrice>)[model];
  if (price === undefined) return undefined;

  const usd =
    (usage.inputTokens / 1_000_000) * price.inputPerMTokUsd +
    (usage.outputTokens / 1_000_000) * price.outputPerMTokUsd;

  return {
    // Five places, because a cheap turn on the cheap model is a few thousandths of a cent
    // and rounding it to the nearest cent would report every one of them as free.
    usd: Math.round(usd * 100_000) / 100_000,
    model,
    priceTableVersion: PRICE_TABLE_VERSION,
  };
}
