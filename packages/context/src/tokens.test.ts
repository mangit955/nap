import { describe, expect, it } from "vitest";
import { estimateTokens } from "./tokens.ts";

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
