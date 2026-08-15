import { describe, expect, it } from "vitest";
import {
  manualVisualEvaluation,
  notRunVisualEvaluation,
  parseVisualEvaluation,
  VISUAL_NOT_RUN,
  visualScoreOf,
} from "./visual.ts";

const input = { taskId: "todo", runId: crypto.randomUUID(), screenshots: [] };

describe("notRunVisualEvaluation", () => {
  it("reports not_run, which is the honest answer while no judge exists", async () => {
    expect(await notRunVisualEvaluation().evaluate(input)).toEqual(VISUAL_NOT_RUN);
  });

  it("says why, so a report does not merely omit the category without explanation", async () => {
    const result = await notRunVisualEvaluation().evaluate(input);

    expect(result.status).toBe("not_run");
    if (result.status === "not_run") expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("manualVisualEvaluation", () => {
  it("returns the score somebody supplied, attributed to them", async () => {
    const evaluation = manualVisualEvaluation({ score: 72, source: "manual:mr" });

    expect(await evaluation.evaluate(input)).toEqual({
      status: "scored",
      score: 72,
      source: "manual:mr",
    });
  });

  it("carries notes when given, because a hand-assigned number needs its reasoning", async () => {
    const evaluation = manualVisualEvaluation({
      score: 40,
      source: "manual:mr",
      notes: "unstyled, but laid out",
    });

    expect(await evaluation.evaluate(input)).toMatchObject({ notes: "unstyled, but laid out" });
  });

  it("refuses a score outside 0–100 at construction, not at use", () => {
    // A judge that produced 120 would put a category above its own scale into an archived
    // report, and the run that discovers it is the expensive one.
    expect(() => manualVisualEvaluation({ score: 120, source: "manual" })).toThrow();
    expect(() => manualVisualEvaluation({ score: -1, source: "manual" })).toThrow();
  });
});

describe("visualScoreOf", () => {
  it("is the score when one was produced", () => {
    expect(visualScoreOf({ status: "scored", score: 61, source: "manual" })).toBe(61);
  });

  it("is undefined when not run, which is what renormalises the category away", () => {
    expect(visualScoreOf(VISUAL_NOT_RUN)).toBeUndefined();
  });
});

describe("parseVisualEvaluation", () => {
  it("accepts both shapes", () => {
    expect(parseVisualEvaluation(VISUAL_NOT_RUN).ok).toBe(true);
    expect(parseVisualEvaluation({ status: "scored", score: 0, source: "manual" }).ok).toBe(true);
  });

  it("refuses a scored result with no source", () => {
    // Provider-agnostic means the result must say who produced it: a number in a months-old
    // report that could have come from a person, a pixel diff or a vision model is not a
    // measurement anybody can act on.
    expect(parseVisualEvaluation({ status: "scored", score: 50 }).ok).toBe(false);
  });

  it("refuses a not_run result carrying a score", () => {
    expect(parseVisualEvaluation({ status: "not_run", reason: "no judge", score: 50 }).ok).toBe(
      false,
    );
  });
});
