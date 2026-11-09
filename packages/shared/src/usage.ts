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
import type { TokenUsage } from "./ports/llm-provider.ts";

/**
 * What each kind of token costs, as a multiple of one uncached input token.
 *
 * The one place these numbers live. The turn budget charges by them and the benchmark's cost
 * estimate prices by them, so a budget and a bill cannot disagree about what a cache read is.
 *
 * From Anthropic's published pricing for `claude-opus-5` and `claude-sonnet-5`, the models
 * Nap is demonstrated and measured on: a cache read is 0.1× base input, a cache write with the
 * five-minute lifetime is 1.25×, and output is 5×. The five-minute write is the one that
 * applies, because `ClaudeProvider` marks its breakpoints `{ type: "ephemeral" }` with no TTL;
 * a one-hour write is 2× and would need this table changed alongside the marker.
 *
 * Other vendors through OpenRouter differ a little (an OpenAI model's cache write is not
 * surcharged, and its output ratio is nearer 6×). The table is still the right shape for them,
 * and a budget only needs to be right about proportion — it is a bound on a runaway, not an
 * invoice.
 */
export const BILLED_WEIGHTS = {
  uncachedInput: 1,
  cacheWrite: 1.25,
  cacheRead: 0.1,
  output: 5,
} as const;

// `exactOptional` rather than `optional`: a key that is absent and a key holding `undefined` are
// different things to a `jsonb` column, and only the first survives it. It also makes what this
// parses exactly the port's `TokenUsage`, which `optional` would widen with `| undefined`.
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
 * Cached parts larger than the input they belong to are taken at face value and the uncached
 * remainder at zero, rather than letting a provider's inconsistency make a cost negative.
 */
export function billedTokens(usage: TokenUsage): number {
  return (
    uncachedInputTokens(usage) * BILLED_WEIGHTS.uncachedInput +
    count(usage.cacheWriteTokens) * BILLED_WEIGHTS.cacheWrite +
    count(usage.cacheReadTokens) * BILLED_WEIGHTS.cacheRead +
    count(usage.outputTokens) * BILLED_WEIGHTS.output
  );
}

/** How many output tokens a billed amount pays for: the inverse of the output weight. */
export function outputTokensFor(billed: number): number {
  return Math.floor(count(billed) / BILLED_WEIGHTS.output);
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
