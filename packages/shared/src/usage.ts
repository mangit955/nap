/**
 * What a model call consumed, and what that is worth against a budget.
 *
 * **`inputTokens` is the whole prompt, cached or not.** It is what the context meter shows,
 * what every report written so far recorded, and the one number that says how big a request
 * was. The two cache fields are *parts of it*, not additions to it: a call that read 28k
 * tokens from the cache and sent 300 new ones reports `inputTokens: 28_300` and
 * `cacheReadTokens: 28_000`. What is left over is uncached input, so there is no third field
 * to drift out of step with the other two.
 *
 * **Absent means none.** A provider that says nothing about caching, and every event written
 * before these fields existed, is read as having cached nothing. That is the conservative
 * reading: it charges such usage at the full input price, which is exactly what was charged
 * before. A field is therefore left off rather than written as zero, so the two spellings of
 * "nothing" never both appear in the log.
 *
 * **Why the split matters.** A turn re-sends its whole conversation on every round trip, and
 * from the second one on most of it comes from the cache at a tenth of the price. A budget
 * that counts the prompt at face value runs out an order of magnitude early. See
 * `docs/GOTCHAS.md`, "Model and provider".
 */

import { z } from "zod";

/**
 * What each kind of token costs, as a multiple of one uncached input token of the same model.
 *
 * Read from each vendor's own pricing page on 2026-11-09:
 *
 * - OpenAI, `gpt-5.6-luna` ($0.20 input, $0.02 cached input, $1.20 output per million) and
 *   `gpt-5.6-terra` ($2, $0.20, $12): "Cache writes are billed at 1.25x the uncached input token
 *   rate".
 * - Anthropic, `claude-opus-5` ($5 input, $25 output per million): a cache read is 0.1x base
 *   input and a five-minute cache write 1.25x. The five-minute write is the one that applies,
 *   because `ClaudeProvider` marks its breakpoints `{ type: "ephemeral" }` with no TTL; a one-hour
 *   write is 2x and would need this table changed alongside the marker.
 *
 * So the cache multipliers are the same everywhere Nap runs, and only output differs.
 */
export type BilledWeights = {
  readonly uncachedInput: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly output: number;
};

/** A cache read, as a multiple of uncached input, at every vendor in the table below. */
const CACHE_READ_WEIGHT = 0.1;
/** A five-minute cache write, likewise. */
const CACHE_WRITE_WEIGHT = 1.25;

function weights(output: number): BilledWeights {
  return {
    uncachedInput: 1,
    cacheWrite: CACHE_WRITE_WEIGHT,
    cacheRead: CACHE_READ_WEIGHT,
    output,
  };
}

/**
 * The weights of each model Nap runs on, keyed by the ids `MODEL_PRICES` in `@nap/bench/pricing`
 * uses — a test there holds the two tables to the same models and the same output ratio.
 *
 * The one place these numbers live. The provider hands a turn its row (`LLMTurn.billedWeights`),
 * the turn budget charges by it, and the benchmark's cost estimate prices cached input by it, so a
 * budget and a bill cannot disagree about what a cache read is.
 */
export const MODEL_BILLED_WEIGHTS = {
  "openai/gpt-5.6-luna": weights(6),
  "openai/gpt-5.6-terra": weights(6),
  "anthropic/claude-opus-5": weights(5),
} as const satisfies Record<string, BilledWeights>;

/**
 * For a model the table does not know: each weight the largest any known model has.
 *
 * A budget charging an unknown model too much stops a turn early; one charging too little lets a
 * runaway spend past the ceiling it was given. Derived rather than typed in, so a row added above
 * moves it.
 */
export const FALLBACK_BILLED_WEIGHTS: BilledWeights = Object.values(MODEL_BILLED_WEIGHTS).reduce(
  (max: BilledWeights, row: BilledWeights) => ({
    uncachedInput: Math.max(max.uncachedInput, row.uncachedInput),
    cacheWrite: Math.max(max.cacheWrite, row.cacheWrite),
    cacheRead: Math.max(max.cacheRead, row.cacheRead),
    output: Math.max(max.output, row.output),
  }),
);

/** A model's row, or the fallback for a model nobody priced or no model at all. */
export function billedWeightsFor(model: string | undefined): BilledWeights {
  // `Object.hasOwn` rather than a plain lookup: `toString` is on every object, and a model id
  // arrives from a flag or a request, so "a model named like an Object method" is reachable.
  if (model === undefined || !Object.hasOwn(MODEL_BILLED_WEIGHTS, model))
    return FALLBACK_BILLED_WEIGHTS;
  return MODEL_BILLED_WEIGHTS[model as keyof typeof MODEL_BILLED_WEIGHTS];
}

// `exactOptional` rather than `optional`: a key that is absent and a key holding `undefined` are
// different things to a `jsonb` column, and only the first survives it. `optional` would also
// widen `TokenUsage` below with `| undefined`, which every caller would then have to handle.
export const TokenUsageSchema = z
  .strictObject({
    inputTokens: z.int().nonnegative(),
    outputTokens: z.int().nonnegative(),
    /** Of `inputTokens`, the part written to the prompt cache. Absent on usage from before it. */
    cacheWriteTokens: z.int().nonnegative().exactOptional(),
    /** Of `inputTokens`, the part read from the prompt cache. Absent on usage from before it. */
    cacheReadTokens: z.int().nonnegative().exactOptional(),
  })
  .refine(
    (usage) => (usage.cacheWriteTokens ?? 0) + (usage.cacheReadTokens ?? 0) <= usage.inputTokens,
    { message: "cached input cannot exceed the input it is part of", path: ["inputTokens"] },
  );

/** What one call, or a turn's worth of calls, consumed. `@nap/shared/ports/llm-provider` re-exports it. */
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/**
 * Builds usage from the three ways a provider bills input, plus output.
 *
 * Every count crosses a boundary from somebody else's server — OpenRouter answers `null` for a
 * model that does no caching, and a missing field would make `undefined + 0` a `NaN` that then
 * poisons every total it is added to. So anything that is not a finite, non-negative number is
 * read as zero here, once, rather than at each place a total is taken.
 */
export function tokenUsage(parts: {
  uncached: number | null | undefined;
  cacheWrite: number | null | undefined;
  cacheRead: number | null | undefined;
  output: number | null | undefined;
}): TokenUsage {
  const cacheWrite = count(parts.cacheWrite);
  const cacheRead = count(parts.cacheRead);
  return withCache(
    {
      inputTokens: count(parts.uncached) + cacheWrite + cacheRead,
      outputTokens: count(parts.output),
    },
    cacheWrite,
    cacheRead,
  );
}

/** The part of the input that came from neither side of the cache. Never negative. */
export function uncachedInputTokens(usage: TokenUsage): number {
  return Math.max(
    0,
    count(usage.inputTokens) - count(usage.cacheWriteTokens) - count(usage.cacheReadTokens),
  );
}

/**
 * Usage as a number of uncached-input-token equivalents: what it was billed at, in the unit
 * the turn budget is denominated in. Never `NaN` and never negative.
 *
 * The weights are always the caller's to name — those of the model that produced the usage, which
 * is the turn's `billedWeights`. There is no default because a default is how a helper on a cheaper
 * model ends up charged at the lead's rate.
 *
 * Cached parts larger than the input they belong to are taken at face value and the uncached
 * remainder at zero, rather than letting a provider's inconsistency make a cost negative.
 */
export function billedTokens(usage: TokenUsage, weights: BilledWeights): number {
  return (
    uncachedInputTokens(usage) * weights.uncachedInput +
    count(usage.cacheWriteTokens) * weights.cacheWrite +
    count(usage.cacheReadTokens) * weights.cacheRead +
    count(usage.outputTokens) * weights.output
  );
}

/** How many output tokens a billed amount pays for: the inverse of the output weight. */
export function outputTokensFor(billed: number, weights: BilledWeights): number {
  return Math.floor(count(billed) / weights.output);
}

/**
 * Two usages summed, cache fields included.
 *
 * The one way to add usage. Summing `inputTokens` and `outputTokens` by hand, as every
 * accumulator once did, silently drops the cache split at the first `+`.
 */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return withCache(
    {
      inputTokens: count(a.inputTokens) + count(b.inputTokens),
      outputTokens: count(a.outputTokens) + count(b.outputTokens),
    },
    count(a.cacheWriteTokens) + count(b.cacheWriteTokens),
    count(a.cacheReadTokens) + count(b.cacheReadTokens),
  );
}

/** Adds the cache fields that are non-zero, and only those — absent already means zero. */
function withCache(
  usage: { inputTokens: number; outputTokens: number },
  cacheWrite: number,
  cacheRead: number,
): TokenUsage {
  return {
    ...usage,
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
  };
}

function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
