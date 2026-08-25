import { describe, expect, it } from "vitest";
import { compareRuns, formatComparison } from "./compare.ts";
import type { BenchReport } from "./report.ts";
import { benchCheck, benchReport } from "./testing/bench-report.ts";
import { scriptedJudgement } from "./testing/scripted-judgement.ts";

function compared(baseline: BenchReport, candidate: BenchReport) {
  const result = compareRuns(baseline, candidate);
  if (!result.ok) throw new Error(`expected a comparison, got: ${result.error}`);
  return result.value;
}

function refused(baseline: BenchReport, candidate: BenchReport): string {
  const result = compareRuns(baseline, candidate);
  if (result.ok) throw new Error("expected the comparison to be refused");
  return result.error;
}

/** Two runs of one task, scored over the same categories with the same effective weights. */
function pair(
  baseline: Partial<BenchReport>,
  candidate: Partial<BenchReport>,
): [BenchReport, BenchReport] {
  const categories = [
    { category: "functional" as const, score: 50, effectiveWeight: 83.3, checks: 2 },
    { category: "code" as const, score: 100, effectiveWeight: 16.7, checks: 1 },
  ];
  return [
    benchReport({ status: "failed", score: 58, categories, ...baseline }),
    benchReport({ status: "failed", score: 58, categories, ...candidate }),
  ];
}

describe("compareRuns", () => {
  it("reports what the overall score did", () => {
    const [baseline, candidate] = pair(
      { score: 58 },
      {
        score: 83,
        categories: [
          { category: "functional", score: 100, effectiveWeight: 83.3, checks: 2 },
          { category: "code", score: 100, effectiveWeight: 16.7, checks: 1 },
        ],
      },
    );

    const comparison = compared(baseline, candidate);

    expect(comparison.scoreDelta).toBe(25);
    expect(comparison.baseline.score).toBe(58);
    expect(comparison.candidate.score).toBe(83);
  });

  it("reports what each category did", () => {
    const [baseline, candidate] = pair(
      {},
      {
        score: 83,
        categories: [
          { category: "functional", score: 100, effectiveWeight: 83.3, checks: 2 },
          { category: "code", score: 100, effectiveWeight: 16.7, checks: 1 },
        ],
      },
    );

    expect(compared(baseline, candidate).categories).toEqual([
      {
        category: "functional",
        baseline: 50,
        candidate: 100,
        delta: 50,
        effectiveWeight: 83.3,
      },
      { category: "code", baseline: 100, candidate: 100, delta: 0, effectiveWeight: 16.7 },
    ]);
  });

  it("names the individual checks that changed, which is the part that explains a delta", () => {
    const [baseline, candidate] = pair(
      {
        checks: [
          benchCheck({ checkId: "adds-a-todo", outcome: "passed" }),
          benchCheck({ checkId: "survives-a-reload", outcome: "passed" }),
          benchCheck({ checkId: "filters-by-completion", outcome: "failed", detail: "exit 1" }),
        ],
      },
      {
        checks: [
          benchCheck({ checkId: "adds-a-todo", outcome: "passed" }),
          benchCheck({ checkId: "survives-a-reload", outcome: "failed", detail: "exit 1" }),
          benchCheck({ checkId: "filters-by-completion", outcome: "passed" }),
        ],
      },
    );

    expect(compared(baseline, candidate).checks).toEqual([
      {
        checkId: "adds-a-todo",
        category: "functional",
        baseline: "passed",
        candidate: "passed",
        movement: "unchanged",
      },
      {
        checkId: "survives-a-reload",
        category: "functional",
        baseline: "passed",
        candidate: "failed",
        movement: "broken",
      },
      {
        checkId: "filters-by-completion",
        category: "functional",
        baseline: "failed",
        candidate: "passed",
        movement: "fixed",
      },
    ]);
  });

  it("keeps a check that only one of the runs has, rather than dropping it silently", () => {
    const [baseline, candidate] = pair(
      { checks: [benchCheck({ checkId: "was-here" })] },
      { checks: [benchCheck({ checkId: "is-new" })] },
    );

    expect(compared(baseline, candidate).checks).toEqual([
      {
        checkId: "was-here",
        category: "functional",
        baseline: "passed",
        candidate: null,
        movement: "removed",
      },
      {
        checkId: "is-new",
        category: "functional",
        baseline: null,
        candidate: "passed",
        movement: "added",
      },
    ]);
  });

  it("shows the route as well as the result, so two equal scores can still differ", () => {
    const [baseline, candidate] = pair(
      {
        metrics: {
          toolCalls: 8,
          toolFailures: 0,
          commands: 2,
          filesChanged: 3,
          turns: { started: 1, completed: 1, failed: 0, cancelled: 0 },
          tokens: { inputTokens: 10_000, outputTokens: 500 },
          turnDurationMs: 30_000,
        },
      },
      {
        metrics: {
          toolCalls: 26,
          toolFailures: 4,
          commands: 9,
          filesChanged: 3,
          turns: { started: 1, completed: 1, failed: 0, cancelled: 0 },
          tokens: { inputTokens: 42_000, outputTokens: 1_500 },
          turnDurationMs: 95_000,
        },
      },
    );

    const comparison = compared(baseline, candidate);

    expect(comparison.scoreDelta).toBe(0);
    expect(comparison.metrics.toolCalls).toEqual({ baseline: 8, candidate: 26, delta: 18 });
    expect(comparison.metrics.toolFailures).toEqual({ baseline: 0, candidate: 4, delta: 4 });
    expect(comparison.metrics.inputTokens).toEqual({
      baseline: 10_000,
      candidate: 42_000,
      delta: 32_000,
    });
    // The claim the trajectory exists to support: same result, different journey.
    expect(comparison.sameScoreDifferentRoute).toBe(true);
  });

  it("does not call two identical runs a different route", () => {
    const [baseline, candidate] = pair({}, {});

    expect(compared(baseline, candidate).sameScoreDifferentRoute).toBe(false);
  });

  it("does not call a run that took a millisecond longer a different route", () => {
    // Duration and tokens vary between two runs that did exactly the same thing. A flag that
    // watched them would fire on every pair, which is how a signal becomes noise — this was
    // observed on two identical dry runs before it was fixed.
    const metrics = {
      toolCalls: 4,
      toolFailures: 0,
      commands: 1,
      filesChanged: 2,
      turns: { started: 1, completed: 1, failed: 0, cancelled: 0 },
    };
    const [baseline, candidate] = pair(
      {
        metrics: {
          ...metrics,
          turnDurationMs: 1_000,
          tokens: { inputTokens: 900, outputTokens: 40 },
        },
      },
      {
        metrics: {
          ...metrics,
          turnDurationMs: 1_400,
          tokens: { inputTokens: 950, outputTokens: 44 },
        },
      },
    );

    const comparison = compared(baseline, candidate);

    expect(comparison.sameScoreDifferentRoute).toBe(false);
    // Still reported, because a run that took 40% longer for the same work is worth seeing.
    expect(comparison.metrics.turnDurationMs).toEqual({
      baseline: 1_000,
      candidate: 1_400,
      delta: 400,
    });
  });

  it("leaves a figure absent on both sides when neither run could supply it", () => {
    // A failed turn reports no usage at all, and a delta invented from two absences would be
    // the one number in a comparison nobody could trace back to a measurement.
    const [baseline, candidate] = pair({}, {});

    expect(compared(baseline, candidate).metrics.inputTokens).toBeUndefined();
  });

  it("compares an unscored run without pretending it has a number", () => {
    const baseline = benchReport({ status: "passed", score: 90, categories: [] });
    const candidate = benchReport({
      status: "errored",
      score: null,
      errorKind: "sandbox",
      categories: [],
    });

    const comparison = compared(baseline, candidate);

    expect(comparison.scoreDelta).toBeNull();
    expect(comparison.candidate.status).toBe("errored");
    expect(comparison.candidate.errorKind).toBe("sandbox");
  });
});

describe("compareRuns and the budget the runs were held at", () => {
  const budget = (maxSteps: number) => ({
    model: "openai/gpt-5.6-luna",
    budget: { maxSteps, maxTokens: 400_000 },
    harness: null,
  });

  it("refuses two runs held at different ceilings", () => {
    // `budget_exceeded` is attributed to the agent, which is only honest while the ceiling is
    // genuinely fixed. Across two different ones, "this model ran out" is a property of a
    // setting being presented as a property of a model.
    const [baseline, candidate] = pair({ configuration: budget(40) }, { configuration: budget(8) });

    expect(refused(baseline, candidate)).toMatch(/budget/i);
  });

  it("names both ceilings, so the reader can see which way it moved", () => {
    const [baseline, candidate] = pair({ configuration: budget(40) }, { configuration: budget(8) });

    const message = refused(baseline, candidate);

    expect(message).toContain("40 steps");
    expect(message).toContain("8 steps");
  });

  it("compares two runs held at the same ceiling", () => {
    const [baseline, candidate] = pair(
      { configuration: budget(40) },
      { configuration: budget(40) },
    );

    expect(compared(baseline, candidate).scoreDelta).toBe(0);
  });

  it("compares when either run never recorded one", () => {
    // Every report written before the field existed has a null budget. Refusing on an unknown
    // would make the whole archive incomparable with everything after it — refusing on the
    // strength of a fact nobody wrote down.
    const [baseline, candidate] = pair({}, { configuration: budget(8) });

    expect(compared(baseline, candidate).scoreDelta).toBe(0);
  });

  it("refuses even when neither run has a score", () => {
    // Deliberately unlike the weights refusal, which skips unscored runs because there is no
    // number to reprice. A budget mismatch invalidates the *attribution* rather than the
    // arithmetic, and an errored run is exactly where the attribution is the whole finding:
    // one run erroring `agent` for an exhausted budget the other was never held to is the
    // most misleading comparison this tool could draw.
    const baseline = benchReport({
      status: "errored",
      score: null,
      errorKind: "agent",
      categories: [],
      configuration: budget(8),
    });
    const candidate = benchReport({
      status: "errored",
      score: null,
      errorKind: "agent",
      categories: [],
      configuration: budget(40),
    });

    expect(refused(baseline, candidate)).toMatch(/budget/i);
  });

  it("does not refuse two runs of different models, which is the whole point", () => {
    const [baseline, candidate] = pair(
      {
        configuration: {
          model: "openai/gpt-5.6-luna",
          budget: { maxSteps: 40, maxTokens: 1 },
          harness: null,
        },
      },
      {
        configuration: {
          model: "anthropic/claude-opus-5",
          budget: { maxSteps: 40, maxTokens: 1 },
          harness: null,
        },
      },
    );

    expect(compared(baseline, candidate).scoreDelta).toBe(0);
  });
});

/**
 * The weight vector's argument, applied to the other half. A grade is one model's answer to one
 * wording of one rubric, so two product halves subtracted measure the change of instrument.
 */
describe("compareRuns and which judge graded each side", () => {
  function judged(source: string, rubricVersion: string): Partial<BenchReport> {
    const judgement = scriptedJudgement([
      { surfaceId: "home", viewport: "desktop", path: "home/desktop.png" },
    ]);
    if (judgement.status !== "judged") throw new Error("the scripted judge always judges");

    return {
      scoringModel: "v2",
      halves: { objective: 58, product: 70 },
      product: { ...judgement, judge: { source, rubricVersion } },
    };
  }

  it("refuses two runs graded by different models", () => {
    const [baseline, candidate] = pair(
      judged("openrouter:openai/a", "product-1"),
      judged("openrouter:openai/b", "product-1"),
    );

    expect(refused(baseline, candidate)).toMatch(/different judges/i);
  });

  /** The same model asked a reworded question is a different instrument. */
  it("refuses two runs graded against different rubric versions", () => {
    const [baseline, candidate] = pair(
      judged("openrouter:openai/a", "product-1"),
      judged("openrouter:openai/a", "product-2"),
    );

    expect(refused(baseline, candidate)).toMatch(/rubric/i);
  });

  it("compares two runs graded by the same judge", () => {
    const [baseline, candidate] = pair(
      judged("openrouter:openai/a", "product-1"),
      judged("openrouter:openai/a", "product-1"),
    );

    expect(compared(baseline, candidate).scoreDelta).toBe(0);
  });

  /** The entire archive predates the judge, and it is one instrument: none. */
  it("does not refuse two runs that were never judged", () => {
    const [baseline, candidate] = pair({}, {});

    expect(compared(baseline, candidate).scoreDelta).toBe(0);
  });

  /**
   * Nothing to reprice on a run with no number, and refusing here would make an errored run
   * incomparable with anything — which is precisely when somebody wants to see the other side.
   */
  it("says nothing about judges when either run produced no score", () => {
    const [baseline] = pair(judged("openrouter:openai/a", "product-1"), {});
    // Scored the same way, and it crashed before anybody looked: no halves, no judgement.
    const candidate = benchReport({
      status: "errored",
      score: null,
      categories: [],
      scoringModel: "v2",
    });

    expect(compared(baseline, candidate).scoreDelta).toBeNull();
  });
});

describe("compareRuns and which Nap produced each side", () => {
  const harness = (
    overrides: Partial<{ commit: string; dirty: boolean; verification: boolean }>,
  ) => ({
    model: "openai/gpt-5.6-luna",
    budget: null,
    harness: {
      commit: "9e107d9d372bb6826bd81d3542a419d6c2b0f5a1",
      dirty: false,
      verification: true,
      ...overrides,
    },
  });

  it("says when the two sides were produced by different Naps", () => {
    const [baseline, candidate] = pair(
      { configuration: harness({ verification: false }) },
      { configuration: harness({ verification: true }) },
    );

    const comparison = compared(baseline, candidate);

    expect(comparison.harness.differs).toBe(true);
    expect(comparison.harness.baseline?.verification).toBe(false);
    expect(comparison.harness.candidate?.verification).toBe(true);
  });

  it("compares them anyway — this is the comparison V2 exists to make", () => {
    // Deliberately unlike the budget and the weight vector, both of which refuse. Refusing here
    // would refuse the only comparison the harness identity was ever recorded for, and would
    // strand every report written before verification existed as well.
    const [baseline, candidate] = pair(
      { configuration: harness({ commit: "a".repeat(40), verification: false }) },
      { configuration: harness({ verification: true }) },
    );

    expect(compareRuns(baseline, candidate).ok).toBe(true);
    expect(compared(baseline, candidate).scoreDelta).toBe(0);
  });

  it("does not claim a difference it cannot see", () => {
    // A pre-V2 report has no harness at all. That is *unrecorded*, and reading it as a
    // difference would put a caveat on every comparison drawn against the archive.
    const [baseline, candidate] = pair({}, { configuration: harness({}) });

    expect(compared(baseline, candidate).harness).toStrictEqual({
      baseline: null,
      candidate: harness({}).harness,
      differs: false,
    });
  });

  it("puts a differing harness above the numbers it explains, and says what it means", () => {
    const [baseline, candidate] = pair(
      { configuration: harness({ verification: false }) },
      { configuration: harness({ commit: "b".repeat(40), dirty: true }) },
    );

    const printed = formatComparison(compared(baseline, candidate));
    const [harnessLine, overallLine] = printed
      .split("\n")
      .filter((line) => /harness|overall/.test(line));

    expect(harnessLine).toContain("9e107d9d, verification off");
    expect(harnessLine).toContain("bbbbbbbb (modified), verification on");
    expect(overallLine).toContain("overall");
    expect(printed).toContain("different Naps");
  });

  it("says nothing about the harness when the two sides cannot be told apart", () => {
    const [baseline, candidate] = pair(
      { configuration: harness({}) },
      { configuration: harness({}) },
    );

    expect(formatComparison(compared(baseline, candidate))).not.toMatch(/harness/i);
  });
});

describe("compareRuns refuses what cannot honestly be compared", () => {
  it("refuses two runs whose configured weights moved the effective vector", () => {
    const [baseline, candidate] = pair(
      {},
      {
        weights: { functional: 40, browser: 25, visual: 15, code: 20 },
        categories: [
          { category: "functional", score: 50, effectiveWeight: 66.7, checks: 2 },
          { category: "code", score: 100, effectiveWeight: 33.3, checks: 1 },
        ],
      },
    );

    expect(refused(baseline, candidate)).toMatch(/weight/i);
  });

  it("compares two runs whose configured weights differ where it made no difference", () => {
    // Reweighting a category that neither run scored changes nothing: both renormalise to the
    // same vector, and ADR-0002 refuses on the *effective* one for exactly this reason.
    const [baseline, candidate] = pair(
      {},
      { weights: { functional: 50, browser: 25, visual: 40, code: 10 } },
    );

    expect(compareRuns(baseline, candidate).ok).toBe(true);
  });

  it("refuses two runs whose effective vectors differ, even under the same configuration", () => {
    // The case ADR-0002 is written about: the day a visual judge lands, a run scored with it
    // is on a different scale from every run before it, and subtracting the two is a lie.
    const [baseline, candidate] = pair(
      {},
      {
        score: 60,
        categories: [
          { category: "functional", score: 50, effectiveWeight: 76.9, checks: 2 },
          { category: "visual", score: 80, effectiveWeight: 7.7, checks: 0 },
          { category: "code", score: 100, effectiveWeight: 15.4, checks: 1 },
        ],
      },
    );

    const error = refused(baseline, candidate);
    expect(error).toMatch(/visual/);
    expect(error).toMatch(/weight/i);
  });

  it("refuses two runs of different tasks", () => {
    const [baseline, candidate] = pair({ taskId: "todo-crud" }, { taskId: "landing-page" });

    expect(refused(baseline, candidate)).toMatch(/todo-crud/);
  });

  it("does not check weights it has no business checking on an unscored run", () => {
    // An errored run has no categories, so an effective vector comparison would refuse every
    // pairing with one — and there is no number there to be repriced in the first place.
    const [baseline] = pair({}, {});
    const candidate = benchReport({
      status: "errored",
      score: null,
      errorKind: "model",
      categories: [],
    });

    expect(compareRuns(baseline, candidate).ok).toBe(true);
  });
});

describe("formatComparison", () => {
  it("leads with the overall movement, signed", () => {
    const [baseline, candidate] = pair(
      {},
      {
        score: 83,
        categories: [
          { category: "functional", score: 100, effectiveWeight: 83.3, checks: 2 },
          { category: "code", score: 100, effectiveWeight: 16.7, checks: 1 },
        ],
      },
    );

    const text = formatComparison(compared(baseline, candidate));

    expect(text).toMatch(/58 → 83/);
    expect(text).toMatch(/\+25/);
  });

  it("names the checks that broke and the checks that were fixed", () => {
    const [baseline, candidate] = pair(
      {
        checks: [
          benchCheck({ checkId: "survives-a-reload", outcome: "passed" }),
          benchCheck({ checkId: "filters-by-completion", outcome: "failed" }),
          benchCheck({ checkId: "adds-a-todo", outcome: "passed" }),
        ],
      },
      {
        checks: [
          benchCheck({ checkId: "survives-a-reload", outcome: "failed" }),
          benchCheck({ checkId: "filters-by-completion", outcome: "passed" }),
          benchCheck({ checkId: "adds-a-todo", outcome: "passed" }),
        ],
      },
    );

    const text = formatComparison(compared(baseline, candidate));

    expect(text).toMatch(/survives-a-reload/);
    expect(text).toMatch(/filters-by-completion/);
    // An unchanged check is not worth a line: it is what the category counts already say.
    expect(text).not.toMatch(/adds-a-todo/);
  });

  it("says when the score held still and the route did not", () => {
    const [baseline, candidate] = pair(
      {},
      {
        metrics: {
          toolCalls: 40,
          toolFailures: 0,
          commands: 0,
          filesChanged: 0,
          turns: { started: 1, completed: 1, failed: 0, cancelled: 0 },
        },
      },
    );

    expect(formatComparison(compared(baseline, candidate))).toMatch(/same score, different route/i);
  });
});

describe("compareRuns on the parts a score alone would hide", () => {
  it("calls a check that stopped being asked a change, not a non-event", () => {
    // An absent check renormalises its category out and moves the overall score (ADR-0002),
    // so calling it "unchanged" would hand somebody a moved number with nothing explaining it.
    const [baseline, candidate] = pair(
      { checks: [benchCheck({ checkId: "drives-the-app", outcome: "passed" })] },
      { checks: [benchCheck({ checkId: "drives-the-app", outcome: "absent", detail: "—" })] },
    );

    const [check] = compared(baseline, candidate).checks;
    expect(check?.movement).toBe("changed");
    expect(formatComparison(compared(baseline, candidate))).toMatch(/drives-the-app/);
  });

  it("keeps a category only one run scored, rather than dropping it", () => {
    // The case this matters in is an unscored baseline: the candidate's whole breakdown is
    // what somebody is looking at, and intersecting the two lists erases it.
    const baseline = benchReport({ status: "errored", score: null, errorKind: "sandbox" });
    const candidate = benchReport({
      status: "failed",
      score: 58,
      categories: [{ category: "functional", score: 58, effectiveWeight: 100, checks: 2 }],
    });

    expect(compared(baseline, candidate).categories).toEqual([
      {
        category: "functional",
        baseline: null,
        candidate: 58,
        delta: null,
        effectiveWeight: 100,
      },
    ]);
  });

  it("prints how much longer the same work took", () => {
    const metrics = {
      toolCalls: 4,
      toolFailures: 0,
      commands: 1,
      filesChanged: 2,
      turns: { started: 1, completed: 1, failed: 0, cancelled: 0 },
    };
    const [baseline, candidate] = pair(
      { metrics: { ...metrics, turnDurationMs: 30_000 } },
      { metrics: { ...metrics, turnDurationMs: 95_000 } },
    );

    expect(formatComparison(compared(baseline, candidate))).toMatch(/30\.0s → 95\.0s/);
  });
});
