import { describe, expect, it } from "vitest";
import { CORPUS_ROOT } from "./corpus-fixtures.ts";
import { resolveProductJudge } from "./product-judge.ts";

describe("resolveProductJudge", () => {
  /**
   * This is a test of a stated absence, and it is meant to fail the day a vision adapter lands —
   * which is what makes it worth having. The alternative is a seam nobody notices is still empty,
   * and a paid run that reports `not_run` for a reason nobody went looking for.
   */
  it("reports that no judge is composed, and why", () => {
    const resolved = resolveProductJudge({}, { screenshotRoot: CORPUS_ROOT });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("no vision judge is composed");
  });
});
