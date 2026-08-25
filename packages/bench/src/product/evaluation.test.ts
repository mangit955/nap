import { describe, expect, it } from "vitest";
import { PRODUCT_DIMENSIONS, type ProductDimension } from "./dimension.ts";
import {
  notRunProductEvaluation,
  scriptedProductEvaluation,
  surfaceScreenshotsOf,
} from "./evaluation.ts";
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

describe("surfaceScreenshotsOf", () => {
  const viewport = { name: "mobile", width: 375, height: 812 } as const;

  it("hands over the surfaces the capture pass asked for, in the order it took them", () => {
    const surfaces = surfaceScreenshotsOf([
      {
        checkId: null,
        surface: { id: "empty", viewport: "mobile" },
        viewport,
        path: "todo-empty-mobile.png",
        capturedAt: "2026-08-15T04:05:06.000Z",
      },
      {
        checkId: null,
        surface: { id: "empty", viewport: "desktop" },
        viewport: { name: "desktop", width: 1280, height: 800 },
        path: "todo-empty-desktop.png",
        capturedAt: "2026-08-15T04:05:07.000Z",
      },
    ]);

    expect(surfaces).toEqual([
      { surfaceId: "empty", viewport: "mobile", path: "todo-empty-mobile.png" },
      { surfaceId: "empty", viewport: "desktop", path: "todo-empty-desktop.png" },
    ]);
  });

  it("leaves out a check's by-product, which cannot be paired with anything", () => {
    const surfaces = surfaceScreenshotsOf([
      {
        checkId: "renders-the-page",
        surface: null,
        viewport,
        path: "todo-renders-the-page.png",
        capturedAt: "2026-08-15T04:05:06.000Z",
      },
    ]);

    expect(surfaces).toEqual([]);
  });

  it("labels a surface by the size it was asked for, not the size the page came back at", () => {
    // The interesting disagreement: a page that resized itself is measured at something else,
    // and the requested name is the only thing that still pairs the two images of one view.
    const surfaces = surfaceScreenshotsOf([
      {
        checkId: null,
        surface: { id: "home", viewport: "mobile" },
        viewport: { name: null, width: 900, height: 700 },
        path: "todo-home-mobile.png",
        capturedAt: "2026-08-15T04:05:06.000Z",
      },
    ]);

    expect(surfaces[0]?.viewport).toBe("mobile");
  });
});
