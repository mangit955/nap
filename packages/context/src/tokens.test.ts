import { describe, expect, it } from "vitest";
import { estimateTokens, type Keep, truncateToTokens } from "./tokens.ts";

describe("estimateTokens", () => {
  it("is zero for the empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("grows with length", () => {
    expect(estimateTokens("x".repeat(400))).toBeGreaterThan(estimateTokens("x".repeat(40)));
  });

  it("never returns a fraction", () => {
    // Budgets are compared and subtracted; a fractional token would make the arithmetic
    // drift and the truncation loop terminate on a value nobody can reason about.
    for (const length of [1, 2, 3, 5, 7, 13, 101]) {
      expect(Number.isInteger(estimateTokens("x".repeat(length)))).toBe(true);
    }
  });

  it("never returns zero for non-empty input", () => {
    // A string that estimates to zero is free, and free content is content the truncation
    // loop will never remove — an infinite loop when the budget cannot otherwise be met.
    for (const text of ["a", "ab", "abc"]) {
      expect(estimateTokens(text)).toBeGreaterThan(0);
    }
  });

  it("is deterministic", () => {
    const text = "the quick brown fox jumps over the lazy dog";

    expect(estimateTokens(text)).toBe(estimateTokens(text));
  });

  it("estimates roughly four characters per token", () => {
    // Pins the ratio so a change to it is a deliberate edit rather than a silent drift in
    // what every budget in the system means.
    expect(estimateTokens("x".repeat(4000))).toBe(1000);
  });
});

describe("truncateToTokens", () => {
  const ends: Keep[] = ["head", "tail"];

  it.each(ends)("leaves text that already fits alone, keeping the %s", (keep) => {
    expect(truncateToTokens("boom", 100, keep)).toBe("boom");
  });

  it.each(ends)("returns nothing at all for a ceiling of zero, keeping the %s", (keep) => {
    expect(truncateToTokens("x".repeat(400), 0, keep)).toBe("");
  });

  it("keeps the head, for text that says what it wants up front", () => {
    const truncated = truncateToTokens(`the request${"x".repeat(4_000)}`, 100, "head");

    expect(truncated.startsWith("the request")).toBe(true);
  });

  it("keeps the tail, for output whose reason is at the end", () => {
    const truncated = truncateToTokens(`${"x".repeat(4_000)}the reason`, 100, "tail");

    expect(truncated.endsWith("the reason")).toBe(true);
  });

  it.each(ends)("marks the cut, so a fragment reads as one, keeping the %s", (keep) => {
    expect(truncateToTokens("x".repeat(4_000), 100, keep)).toContain("…");
  });

  it.each([
    [1, "head"],
    [1, "tail"],
    [2, "head"],
    [7, "tail"],
    [100, "head"],
    [999, "tail"],
  ] as const)("never exceeds a ceiling of %i tokens, keeping the %s", (tokens, keep) => {
    // The property every caller depends on. A marker added *on top* of the ceiling rather
    // than taken out of it would make each shrinking step overrun the budget it serves.
    expect(estimateTokens(truncateToTokens("x".repeat(40_000), tokens, keep))).toBeLessThanOrEqual(
      tokens,
    );
  });
});
