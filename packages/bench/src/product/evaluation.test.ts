import { describe, expect, it } from "vitest";
import { PRODUCT_DIMENSIONS, type ProductDimension } from "./dimension.ts";
import { notRunProductEvaluation, scriptedProductEvaluation } from "./evaluation.ts";
import type { DimensionJudgement, ProductJudgement } from "./judgement.ts";

const input = {
  taskId: "expense-ledger",
  runId: "5f0b6f2c-0f1f-4d3f-9a2a-8a1f5c9d0e11",
  intent: "a place to record what was spent and see where it went",
  screenshots: [
    { surfaceId: "home", viewport: "desktop", path: "screenshots/home-desktop.png" },
    { surfaceId: "home", viewport: "mobile", path: "screenshots/home-mobile.png" },
  ],
} as const;

const graded: DimensionJudgement = {
  status: "graded",
  grade: "moderate",
  evidence: [
    {
      surfaceId: "home",
      viewport: "desktop",
      screenshot: "screenshots/home-desktop.png",
      observation: "observed",
    },
  ],
  strengths: [],
  weaknesses: [],
};

const judgement: ProductJudgement = {
  status: "judged",
  judge: { source: "scripted", rubricVersion: "rubric-v1" },
  dimensions: Object.fromEntries(
    PRODUCT_DIMENSIONS.map((dimension) => [dimension, graded]),
  ) as Record<ProductDimension, DimensionJudgement>,
  polish: graded,
};

describe("the product evaluation port", () => {
  it("answers not_run when no judge is configured", async () => {
    const result = await notRunProductEvaluation().evaluate(input);

    expect(result.status).toBe("not_run");
    expect(result.status === "not_run" && result.reason.length).toBeGreaterThan(0);
  });

  it("returns the scripted judgement unchanged, so the free path scores like the paid one", async () => {
    const result = await scriptedProductEvaluation(judgement).evaluate(input);

    expect(result).toEqual(judgement);
  });
});
