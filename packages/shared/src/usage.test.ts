import { describe, expect, it } from "vitest";
import {
  addUsage,
  BILLED_WEIGHTS,
  billedTokens,
  outputTokensFor,
  TokenUsageSchema,
  tokenUsage,
  uncachedInputTokens,
} from "./usage.ts";

describe("tokenUsage", () => {
  it("totals input across the three ways it is billed, and keeps the cached parts apart", () => {
    expect(tokenUsage({ uncached: 300, cacheWrite: 2_000, cacheRead: 28_000, output: 50 })).toEqual(
      { inputTokens: 30_300, outputTokens: 50, cacheWriteTokens: 2_000, cacheReadTokens: 28_000 },
    );
  });

  it("leaves a cache field off when nothing was cached, so absent and zero are one reading", () => {
    expect(tokenUsage({ uncached: 300, cacheWrite: 0, cacheRead: null, output: 5 })).toStrictEqual({
      inputTokens: 300,
      outputTokens: 5,
    });
  });

  it("reads a missing, null, negative or non-finite count as zero rather than poisoning a total", () => {
    const usage = tokenUsage({
      uncached: Number.NaN,
      cacheWrite: undefined,
      cacheRead: -4,
      output: Number.POSITIVE_INFINITY,
    });
    expect(usage).toStrictEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("uncachedInputTokens", () => {
  it("is what is left of the input after both cached parts", () => {
    expect(
      uncachedInputTokens({
        inputTokens: 30_300,
        outputTokens: 0,
        cacheWriteTokens: 2_000,
        cacheReadTokens: 28_000,
      }),
    ).toBe(300);
  });

  it("is all of the input when the cache fields are absent, as on an old event", () => {
    expect(uncachedInputTokens({ inputTokens: 900, outputTokens: 1 })).toBe(900);
  });

  it("never goes negative on usage whose parts overstate the whole", () => {
    expect(uncachedInputTokens({ inputTokens: 10, outputTokens: 0, cacheReadTokens: 50 })).toBe(0);
  });
});

describe("billedTokens", () => {
  it("weights each kind of token by what it is billed at", () => {
    expect(
      billedTokens({
        inputTokens: 30_300,
        outputTokens: 50,
        cacheWriteTokens: 2_000,
        cacheReadTokens: 28_000,
      }),
    ).toBeCloseTo(300 * 1 + 2_000 * 1.25 + 28_000 * 0.1 + 50 * 5);
  });

  it("charges a mostly cached request a fraction of its size", () => {
    const cached = { inputTokens: 30_000, outputTokens: 0, cacheReadTokens: 30_000 };
    expect(billedTokens(cached)).toBeCloseTo(3_000);
  });

  it("charges usage without cache fields as uncached input, which is what an old event was", () => {
    expect(billedTokens({ inputTokens: 1_000, outputTokens: 10 })).toBe(1_050);
  });

  it("is never NaN or negative, whatever arrives", () => {
    const hostile = [
      { inputTokens: Number.NaN, outputTokens: 1 },
      { inputTokens: -100, outputTokens: -5 },
      { inputTokens: 10, outputTokens: 0, cacheReadTokens: Number.NaN },
      { inputTokens: 10, outputTokens: 0, cacheReadTokens: 1_000 },
      { inputTokens: Number.POSITIVE_INFINITY, outputTokens: 0 },
    ];
    for (const usage of hostile) {
      const billed = billedTokens(usage);
      expect(Number.isFinite(billed)).toBe(true);
      expect(billed).toBeGreaterThanOrEqual(0);
    }
  });

  it("prices cache reads below uncached input below cache writes below output", () => {
    // The order the bill puts them in. A weight table that broke it would make the budget
    // prefer exactly the requests that cost most.
    expect(BILLED_WEIGHTS.cacheRead).toBeLessThan(BILLED_WEIGHTS.uncachedInput);
    expect(BILLED_WEIGHTS.uncachedInput).toBeLessThan(BILLED_WEIGHTS.cacheWrite);
    expect(BILLED_WEIGHTS.cacheWrite).toBeLessThan(BILLED_WEIGHTS.output);
  });
});

describe("outputTokensFor", () => {
  it("is how many output tokens a billed amount pays for", () => {
    expect(outputTokensFor(1_000)).toBe(200);
  });

  it("rounds down and never goes negative", () => {
    expect(outputTokensFor(9)).toBe(1);
    expect(outputTokensFor(-50)).toBe(0);
    expect(outputTokensFor(Number.NaN)).toBe(0);
  });
});

describe("addUsage", () => {
  it("sums every field, the cached parts included", () => {
    expect(
      addUsage(
        { inputTokens: 100, outputTokens: 1, cacheReadTokens: 80 },
        { inputTokens: 200, outputTokens: 2, cacheWriteTokens: 50, cacheReadTokens: 100 },
      ),
    ).toStrictEqual({
      inputTokens: 300,
      outputTokens: 3,
      cacheWriteTokens: 50,
      cacheReadTokens: 180,
    });
  });

  it("adds no cache fields to two usages that had none", () => {
    expect(
      addUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 }),
    ).toStrictEqual({ inputTokens: 4, outputTokens: 6 });
  });
});

describe("TokenUsageSchema", () => {
  it("still parses usage written before the cache fields existed", () => {
    expect(TokenUsageSchema.parse({ inputTokens: 10, outputTokens: 2 })).toStrictEqual({
      inputTokens: 10,
      outputTokens: 2,
    });
  });

  it("round-trips usage with its cache fields through JSON", () => {
    const usage = { inputTokens: 30, outputTokens: 2, cacheWriteTokens: 5, cacheReadTokens: 20 };
    expect(TokenUsageSchema.parse(JSON.parse(JSON.stringify(usage)))).toStrictEqual(usage);
  });

  it("refuses cached parts larger than the input they are part of", () => {
    const result = TokenUsageSchema.safeParse({
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 8,
      cacheWriteTokens: 8,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["inputTokens"]);
  });

  it("refuses a negative or fractional cache count", () => {
    for (const cacheReadTokens of [-1, 1.5]) {
      const result = TokenUsageSchema.safeParse({
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens,
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["cacheReadTokens"]);
    }
  });

  it("refuses an unknown key, so a misspelled field cannot vanish on the way into the log", () => {
    const result = TokenUsageSchema.safeParse({ inputTokens: 1, outputTokens: 0, cachedTokens: 1 });
    expect(result.success).toBe(false);
  });
});
