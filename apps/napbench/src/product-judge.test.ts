import { describe, expect, it } from "vitest";
import { CORPUS_ROOT } from "./corpus-fixtures.ts";
import { DEFAULT_JUDGE_MODEL, judgeModelOf, resolveProductJudge } from "./product-judge.ts";
import { visionJudgeIdentity } from "./vision-judge.ts";

describe("resolveProductJudge", () => {
  /**
   * The refusal that has to happen *before* the first sandbox. Every product judgement in a suite
   * failing for want of a key after the turns have been paid for is the expensive way to find out,
   * which is exactly why this is a `Result` a caller must answer rather than a throw at the point
   * of first use.
   */
  it("reports a missing credential rather than composing a judge that cannot ask anything", () => {
    const resolved = resolveProductJudge({}, { screenshotRoot: CORPUS_ROOT });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("OPENROUTER_API_KEY");
  });

  it("treats an empty key as a missing one", () => {
    expect(
      resolveProductJudge({ OPENROUTER_API_KEY: "" }, { screenshotRoot: CORPUS_ROOT }).ok,
    ).toBe(false);
  });

  it("composes a judge when there is a credential", () => {
    const resolved = resolveProductJudge(
      { OPENROUTER_API_KEY: "sk-or-test" },
      { screenshotRoot: CORPUS_ROOT },
    );

    expect(resolved.ok).toBe(true);
  });
});

describe("judgeModelOf", () => {
  /**
   * Pinned, and pinned only after `scripts/vision-reachability.ts` confirmed this id accepts an
   * image through OpenRouter's Anthropic-shaped endpoint. A change here without a re-run is the
   * mistake the whole ordering exists to prevent.
   */
  it("is the verified model by default", () => {
    expect(judgeModelOf({})).toBe(DEFAULT_JUDGE_MODEL);
    expect(visionJudgeIdentity(judgeModelOf({})).source).toBe(`openrouter:${DEFAULT_JUDGE_MODEL}`);
  });

  it("can be pointed at another model without editing code", () => {
    expect(judgeModelOf({ NAP_JUDGE_MODEL: "openai/other" })).toBe("openai/other");
  });

  it("ignores an override that was set to nothing", () => {
    expect(judgeModelOf({ NAP_JUDGE_MODEL: "" })).toBe(DEFAULT_JUDGE_MODEL);
  });
});
