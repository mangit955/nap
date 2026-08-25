import { describe, expect, it } from "vitest";
import { type ScriptedGrades, scriptedJudgement } from "../testing/scripted-judgement.ts";
import { CORPUS_FIXTURES, corpusSurfaceScreenshots } from "./corpus.ts";
import {
  CORPUS_EXPECTATIONS,
  checkDiscrimination,
  describeExpectation,
  isAtLeast,
  isAtMost,
  summariseDiscrimination,
  unmetExpectations,
} from "./discrimination.ts";
import type { Grade } from "./grade.ts";
import { PRODUCT_NOT_RUN, type ProductJudgement } from "./judgement.ts";

/**
 * A judge that knows the answer key.
 *
 * It proves nothing about a real judge, and is deliberately not exported from `testing/` for that
 * reason — what it exercises is the check *around* a judge: that a set of judgements which does
 * discriminate is reported as meeting the expectations, and one that does not is reported as
 * failing them. The real instrument is watched doing this in the paid suite.
 */
function judgeAll(grades: Record<string, ScriptedGrades>): Map<string, ProductJudgement> {
  return new Map(
    CORPUS_FIXTURES.map((fixture) => [
      fixture.id,
      scriptedJudgement(corpusSurfaceScreenshots(fixture.id), grades[fixture.id] ?? {}),
    ]),
  );
}

/**
 * Every scored dimension at one grade, plus `polish` — which is reported and never averaged in,
 * and is set here only so the judgement is complete. This is the simplest way to move a whole
 * product score, since the mean over nine equal anchors is that anchor.
 */
function flat(grade: Grade): ScriptedGrades {
  return {
    hierarchy: grade,
    typography: grade,
    spacing: grade,
    color: grade,
    layout: grade,
    components: grade,
    interaction: grade,
    responsiveness: grade,
    restraint: grade,
    polish: grade,
  };
}

/** The same grade everywhere: a judge that has told nine fixtures apart not at all. */
function everythingAt(grade: Grade): Record<string, ScriptedGrades> {
  return Object.fromEntries(CORPUS_FIXTURES.map((fixture) => [fixture.id, flat(grade)]));
}

/** Judgements that satisfy every expectation the corpus carries. */
function discriminatingJudgements(): Map<string, ProductJudgement> {
  return judgeAll({
    "minimalist-professional": flat("excellent"),
    "ai-slop-generic": flat("poor"),
    "excessive-gradient": { ...flat("moderate"), restraint: "poor" },
    "excessive-icon": { ...flat("moderate"), restraint: "weak" },
    "icons-restrained": { ...flat("good"), restraint: "excellent" },
    "desktop-only-breaks-mobile": { ...flat("moderate"), responsiveness: "poor" },
    "responsive-strong": { ...flat("good"), responsiveness: "excellent" },
    "correct-ugly": flat("weak"),
    "broken-beautiful": flat("excellent"),
  });
}

describe("grade bounds", () => {
  it("reads `at most` as no better than the ceiling", () => {
    expect(isAtMost("weak", "weak")).toBe(true);
    expect(isAtMost("poor", "weak")).toBe(true);
    expect(isAtMost("moderate", "weak")).toBe(false);
    expect(isAtMost("excellent", "weak")).toBe(false);
  });

  it("reads `at least` as no worse than the floor", () => {
    expect(isAtLeast("good", "good")).toBe(true);
    expect(isAtLeast("excellent", "good")).toBe(true);
    expect(isAtLeast("moderate", "good")).toBe(false);
    expect(isAtLeast("poor", "good")).toBe(false);
  });
});

describe("the corpus expectations", () => {
  it("names only fixtures the corpus holds", () => {
    const ids = new Set<string>(CORPUS_FIXTURES.map((fixture) => fixture.id));

    for (const expectation of CORPUS_EXPECTATIONS) {
      const named =
        expectation.kind === "beats"
          ? [expectation.better, expectation.worse]
          : [expectation.fixture];
      for (const id of named) expect(ids.has(id)).toBe(true);
    }
  });

  it("carries the four claims the corpus was designed around", () => {
    const described = CORPUS_EXPECTATIONS.map(describeExpectation);

    expect(described).toEqual(
      expect.arrayContaining([
        expect.stringContaining("minimalist-professional beats ai-slop-generic"),
        expect.stringContaining("excessive-gradient restraint at most weak"),
        expect.stringContaining("icons-restrained restraint at least good"),
        expect.stringContaining("desktop-only-breaks-mobile responsiveness at most weak"),
      ]),
    );
  });

  it("says why each one is expected, so a failure is readable", () => {
    const reasons = CORPUS_EXPECTATIONS.map((expectation) => expectation.because);

    for (const reason of reasons) expect(reason.length).toBeGreaterThan(0);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it("describes each one distinctly, so a summary lists seven claims and not fewer", () => {
    const described = CORPUS_EXPECTATIONS.map(describeExpectation);

    expect(new Set(described).size).toBe(CORPUS_EXPECTATIONS.length);
  });
});

describe("summariseDiscrimination", () => {
  it("counts each status, so a green run that assessed nothing is visible", () => {
    const judgements = discriminatingJudgements();
    judgements.set("icons-restrained", PRODUCT_NOT_RUN);

    const summary = summariseDiscrimination(checkDiscrimination(judgements));

    expect(summary).toBe(
      `${CORPUS_EXPECTATIONS.length - 1} met, 0 unmet, 1 not assessable, of ${CORPUS_EXPECTATIONS.length}`,
    );
  });
});

describe("checkDiscrimination", () => {
  it("meets every expectation when the judgements discriminate", () => {
    const outcomes = checkDiscrimination(discriminatingJudgements());

    expect(outcomes).toHaveLength(CORPUS_EXPECTATIONS.length);
    expect(unmetExpectations(outcomes)).toEqual([]);
  });

  /**
   * The mutation the definition of done asks for, kept as a test rather than performed once by
   * hand: a judge that grades every fixture identically has told none of them apart, and the
   * whole point of this corpus is that such a judge is visibly caught rather than quietly passed.
   */
  it("fails every expectation when one judgement is handed out to everything", () => {
    const outcomes = checkDiscrimination(judgeAll(everythingAt("moderate")));

    expect(unmetExpectations(outcomes)).toHaveLength(CORPUS_EXPECTATIONS.length);
    for (const outcome of outcomes) expect(outcome.status).toBe("unmet");
  });

  it("says what it observed, not only that it disagreed", () => {
    const outcomes = checkDiscrimination(judgeAll({ "icons-restrained": flat("poor") }));
    const restraint = outcomes.find(
      (outcome) =>
        outcome.expectation.kind === "grade_at_least" &&
        outcome.expectation.fixture === "icons-restrained",
    );

    expect(restraint?.status).toBe("unmet");
    expect(restraint?.detail).toContain("poor");
  });

  it("reports a margin that fell short as unmet, with both scores", () => {
    // Every dimension `good` (78) against seven `good` and two `moderate` (73): a five-point
    // gap, which is a rounding difference rather than one product being better than another.
    const outcomes = checkDiscrimination(
      judgeAll({
        "minimalist-professional": flat("good"),
        "ai-slop-generic": { ...flat("good"), color: "moderate", restraint: "moderate" },
      }),
    );
    const margin = outcomes.find(
      (outcome) =>
        outcome.expectation.kind === "beats" && outcome.expectation.worse === "ai-slop-generic",
    );

    expect(margin?.status).toBe("unmet");
    expect(margin?.detail).toContain("78");
    expect(margin?.detail).toContain("73");
  });
});

describe("absence", () => {
  it("is not a failure when nobody judged a fixture", () => {
    const judgements = discriminatingJudgements();
    judgements.set("icons-restrained", PRODUCT_NOT_RUN);

    const outcomes = checkDiscrimination(judgements);
    const affected = outcomes.filter(
      (outcome) =>
        outcome.expectation.kind !== "beats" && outcome.expectation.fixture === "icons-restrained",
    );

    expect(affected.length).toBeGreaterThan(0);
    for (const outcome of affected) expect(outcome.status).toBe("not_assessable");
    expect(unmetExpectations(outcomes)).toEqual([]);
  });

  it("is not a failure when a fixture is missing from the judgements entirely", () => {
    const judgements = discriminatingJudgements();
    judgements.delete("ai-slop-generic");

    const outcomes = checkDiscrimination(judgements);
    const margin = outcomes.find(
      (outcome) =>
        outcome.expectation.kind === "beats" && outcome.expectation.worse === "ai-slop-generic",
    );

    expect(margin?.status).toBe("not_assessable");
    expect(margin?.detail).toContain("ai-slop-generic");
  });

  it("is not a failure when the judge could not assess the dimension asked about", () => {
    // No screenshots at all is how the scripted judge answers `not_assessable` on every
    // dimension — the same absence a real judge reports for a surface that never rendered.
    const judgements = discriminatingJudgements();
    judgements.set("excessive-gradient", scriptedJudgement([]));

    const outcomes = checkDiscrimination(judgements);
    const restraint = outcomes.find(
      (outcome) =>
        outcome.expectation.kind === "grade_at_most" &&
        outcome.expectation.fixture === "excessive-gradient",
    );

    expect(restraint?.status).toBe("not_assessable");
    expect(unmetExpectations(outcomes)).toEqual([]);
  });
});
