import { describe, expect, it } from "vitest";
import { PRODUCT_DIMENSIONS } from "../product/dimension.ts";
import type { SurfaceScreenshot } from "../product/evaluation.ts";
import { parseProductJudgement } from "../product/judgement.ts";
import { scoreProduct } from "../product/product-score.ts";
import { SCRIPTED_GRADES, scriptedJudgement, scriptedProductJudge } from "./scripted-judgement.ts";

const PAIR: SurfaceScreenshot[] = [
  { surfaceId: "empty", viewport: "mobile", path: "todo-empty-mobile.png" },
  { surfaceId: "empty", viewport: "desktop", path: "todo-empty-desktop.png" },
];

const input = {
  taskId: "todo-crud",
  runId: "5f0b6f2c-0f1f-4d3f-9a2a-8a1f5c9d0e11",
  intent: "a place to keep track of what still needs doing",
  screenshots: PAIR,
};

describe("scriptedJudgement", () => {
  it("produces a judgement the schema accepts, which is what makes it exercise the real path", () => {
    // The whole point of the scripted judge: a vision model's answer and this one go through
    // one schema and one scorer, so a free run tests the code a paid run will use.
    const parsed = parseProductJudgement(scriptedJudgement(PAIR));

    expect(parsed.ok).toBe(true);
  });

  it("answers every dimension, so the denominator cannot silently shrink", () => {
    const judgement = scriptedJudgement(PAIR);
    if (judgement.status !== "judged") throw new Error("expected a judged judgement");

    for (const dimension of PRODUCT_DIMENSIONS) {
      expect(judgement.dimensions[dimension].status).toBe("graded");
    }
    expect(judgement.polish.status).toBe("graded");
  });

  it("cites a screenshot it was actually handed, on every graded dimension", () => {
    const judgement = scriptedJudgement(PAIR);
    if (judgement.status !== "judged") throw new Error("expected a judged judgement");

    const paths = new Set(PAIR.map((shot) => shot.path));
    for (const dimension of PRODUCT_DIMENSIONS) {
      const graded = judgement.dimensions[dimension];
      if (graded.status !== "graded") throw new Error(`${dimension} was not graded`);

      expect(graded.evidence.length).toBeGreaterThan(0);
      for (const evidence of graded.evidence) expect(paths).toContain(evidence.screenshot);
    }
  });

  it("cites both sizes of one surface for responsiveness, which is graded on the pair", () => {
    const judgement = scriptedJudgement(PAIR);
    if (judgement.status !== "judged") throw new Error("expected a judged judgement");

    const responsiveness = judgement.dimensions.responsiveness;
    if (responsiveness.status !== "graded") throw new Error("responsiveness was not graded");

    expect(responsiveness.evidence.map((evidence) => evidence.viewport)).toEqual([
      "mobile",
      "desktop",
    ]);
  });

  it("cites one image for responsiveness when only one size was photographed", () => {
    const [mobile] = PAIR;
    if (mobile === undefined) throw new Error("the fixture lost its mobile capture");

    const judgement = scriptedJudgement([mobile]);
    if (judgement.status !== "judged") throw new Error("expected a judged judgement");

    const responsiveness = judgement.dimensions.responsiveness;
    if (responsiveness.status !== "graded") throw new Error("responsiveness was not graded");

    expect(responsiveness.evidence).toHaveLength(1);
  });

  it("grades nothing when there was nothing to look at", () => {
    // Absence, not a bad grade: a run that photographed nothing has told us nothing about the
    // application, and `scoreProduct` renormalises it away rather than scoring it zero.
    const judgement = scriptedJudgement([]);
    if (judgement.status !== "judged") throw new Error("expected a judged judgement");

    for (const dimension of PRODUCT_DIMENSIONS) {
      expect(judgement.dimensions[dimension].status).toBe("not_assessable");
    }
    expect(scoreProduct(judgement)).toBeUndefined();
  });

  it("folds to the mean of its own fixed grades, and to nothing an application decided", () => {
    // 78 + 55 + 78 + 55 + 78 + 55 + 35 + 78 + 55, over nine. Pinned so that a change to the
    // scripted grades has to be deliberate — a dry run's number is meaningless about any
    // application and is *not* meaningless about the arithmetic under it.
    expect(scoreProduct(scriptedJudgement(PAIR))?.score).toBe(63);
  });

  it("takes overridden grades, which is how a fixture is made to discriminate", () => {
    const judgement = scriptedJudgement(PAIR, { restraint: "poor" });
    if (judgement.status !== "judged") throw new Error("expected a judged judgement");

    const restraint = judgement.dimensions.restraint;
    expect(restraint.status === "graded" && restraint.grade).toBe("poor");
    // Untouched dimensions keep the default, so an override says one thing rather than nine.
    const typography = judgement.dimensions.typography;
    expect(typography.status === "graded" && typography.grade).toBe(SCRIPTED_GRADES.typography);
  });

  it("says who graded, and that it was not a model", () => {
    const judgement = scriptedJudgement(PAIR);
    if (judgement.status !== "judged") throw new Error("expected a judged judgement");

    expect(judgement.judge.source).toMatch(/scripted/);
  });
});

describe("scriptedProductJudge", () => {
  it("judges whatever surfaces the run handed it", async () => {
    const judgement = await scriptedProductJudge().evaluate(input);

    expect(judgement).toEqual(scriptedJudgement(PAIR));
  });

  it("carries its overrides through to what it answers", async () => {
    const judgement = await scriptedProductJudge({ polish: "excellent" }).evaluate(input);
    if (judgement.status !== "judged") throw new Error("expected a judged judgement");

    expect(judgement.polish.status === "graded" && judgement.polish.grade).toBe("excellent");
  });
});
