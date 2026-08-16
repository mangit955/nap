import { describe, expect, it } from "vitest";
import type { ErrorKind } from "./error-kind.ts";
import type { BenchReport } from "./report.ts";
import type { RunStatus } from "./status.ts";
import { formatRunSummary, formatSuiteSummary, summariseSuite } from "./summary.ts";
import { benchCheck, benchReport } from "./testing/bench-report.ts";

function scored(status: RunStatus, score: number): BenchReport {
  return benchReport({ status, score });
}

function errored(errorKind: ErrorKind): BenchReport {
  return benchReport({ status: "errored", score: null, errorKind });
}

const cancelled = (): BenchReport => benchReport({ status: "cancelled", score: null });

describe("summariseSuite over repeated runs", () => {
  const run = (taskId: string, score: number): BenchReport =>
    benchReport({ taskId, status: "passed", score });

  it("describes each task's own spread rather than one figure over all of them", () => {
    // The whole point. A standard deviation across two *different* tasks measures how much the
    // tasks differ in difficulty, which is a fact about the benchmark; only a spread within one
    // task is a fact about the model.
    const summary = summariseSuite("all", [
      run("todo-crud", 88),
      run("todo-crud", 74),
      run("todo-crud", 90),
      run("landing-page", 100),
    ]);

    const todo = summary.tasks.find((task) => task.taskId === "todo-crud");
    expect(todo?.scores.n).toBe(3);
    expect(todo?.scores.mean).toBe(84);
    expect(todo?.scores.stdDev).toBe(8.7);
  });

  it("gives a task run once no standard deviation rather than a zero", () => {
    const summary = summariseSuite("all", [run("landing-page", 100)]);

    expect(summary.tasks[0]?.scores.stdDev).toBeNull();
  });

  it("keeps tasks in the order they were first run, not sorted by score", () => {
    // A suite runs its tasks in the order the suite declares, and a reader is comparing this
    // output against the previous run's. Reordering by result would make that impossible.
    const summary = summariseSuite("all", [
      run("landing-page", 100),
      run("todo-crud", 74),
      run("landing-page", 90),
    ]);

    expect(summary.tasks.map((task) => task.taskId)).toEqual(["landing-page", "todo-crud"]);
  });

  it("counts a task's errored runs beside its scores rather than losing them", () => {
    // A task that scored 100 twice and errored twice is not the same as one that scored 100
    // twice, and a distribution alone cannot tell them apart.
    const summary = summariseSuite("all", [
      run("todo-crud", 100),
      benchReport({ taskId: "todo-crud", status: "errored", score: null, errorKind: "sandbox" }),
    ]);

    expect(summary.tasks[0]?.runs).toBe(2);
    expect(summary.tasks[0]?.scores.n).toBe(1);
    expect(summary.tasks[0]?.errored).toBe(1);
  });

  it("prints each task's spread once anything was run more than once", () => {
    const printed = formatSuiteSummary(
      summariseSuite("all", [run("todo-crud", 88), run("todo-crud", 74)]),
    );

    expect(printed).toContain("todo-crud");
    expect(printed).toContain("81.0");
    expect(printed).toMatch(/74.*88|88.*74/s);
  });

  it("says nothing about spread when every task ran once", () => {
    // A "distribution" of one number per task is a second copy of the per-run summaries the
    // reader has just scrolled past, dressed up as statistics.
    const printed = formatSuiteSummary(
      summariseSuite("all", [run("todo-crud", 88), run("landing-page", 100)]),
    );

    expect(printed).not.toContain("spread");
  });

  it("reports the share of counted runs that passed", () => {
    const summary = summariseSuite("all", [
      scored("passed", 100),
      scored("failed", 40),
      errored("sandbox"),
      cancelled(),
    ]);

    // One passed out of three counted; the cancelled run is excluded from both sides, so that
    // whoever ran the suite cannot move the figure by pressing stop.
    expect(summary.successRate).toBe(33.3);
  });
});

describe("summariseSuite", () => {
  it("means over the runs that produced a score, not over every run", () => {
    const summary = summariseSuite("all", [
      scored("passed", 80),
      scored("failed", 40),
      errored("sandbox"),
    ]);

    // 60, not 40: an errored run has no score, and averaging it in as a zero would make an
    // E2B outage look like bad output.
    expect(summary.meanScore).toBe(60);
    expect(summary.completed).toBe(2);
    expect(summary.runs).toBe(3);
  });

  it("keeps the agent-attributable and infrastructure-attributable rates apart", () => {
    const summary = summariseSuite("all", [
      scored("passed", 100),
      errored("agent"),
      errored("sandbox"),
      errored("model"),
    ]);

    expect(summary.agentErrors).toBe(1);
    expect(summary.infrastructureErrors).toBe(2);
    expect(summary.agentErrorRate).toBe(25);
    expect(summary.infrastructureErrorRate).toBe(50);
  });

  it("excludes cancelled runs from the mean and from both rates", () => {
    const summary = summariseSuite("all", [scored("passed", 60), errored("agent"), cancelled()]);

    expect(summary.cancelled).toBe(1);
    expect(summary.counted).toBe(2);
    expect(summary.meanScore).toBe(60);
    // 50, not 33.3: pressing stop must not be able to move a rate.
    expect(summary.agentErrorRate).toBe(50);
  });

  it("has no mean at all when nothing produced a score", () => {
    const summary = summariseSuite("all", [errored("sandbox"), cancelled()]);

    expect(summary.meanScore).toBeNull();
    expect(summary.infrastructureErrorRate).toBe(100);
  });

  it("reports a suite of nothing but cancellations as carrying no numbers", () => {
    const summary = summariseSuite("all", [cancelled(), cancelled()]);

    expect(summary.counted).toBe(0);
    expect(summary.meanScore).toBeNull();
    expect(summary.agentErrorRate).toBe(0);
    expect(summary.infrastructureErrorRate).toBe(0);
  });

  it("calls a suite comparable only when nothing infrastructural errored", () => {
    expect(summariseSuite("all", [scored("failed", 0), errored("agent")]).comparable).toBe(true);
    expect(summariseSuite("all", [scored("passed", 90), errored("browser")]).comparable).toBe(
      false,
    );
  });

  it("rounds the rates rather than printing a recurring decimal", () => {
    const summary = summariseSuite("all", [
      scored("passed", 100),
      scored("passed", 99),
      errored("configuration"),
    ]);

    expect(summary.infrastructureErrorRate).toBe(33.3);
    expect(summary.meanScore).toBe(99.5);
  });
});

describe("formatSuiteSummary", () => {
  it("says loudly that a suite with infrastructure errors is not comparable", () => {
    const text = formatSuiteSummary(
      summariseSuite("all", [scored("passed", 90), errored("sandbox")]),
    );

    expect(text).toMatch(/NOT COMPARABLE/);
    expect(text).toMatch(/infrastructure/i);
  });

  it("says nothing of the kind about a clean suite", () => {
    const text = formatSuiteSummary(
      summariseSuite("all", [scored("passed", 90), errored("agent")]),
    );

    expect(text).not.toMatch(/NOT COMPARABLE/);
    // The rates are still both printed, because a zero is a result worth seeing.
    expect(text).toMatch(/agent/i);
    expect(text).toMatch(/infrastructure/i);
  });

  it("reports the mean as being over completed runs, and how many that was", () => {
    const text = formatSuiteSummary(
      summariseSuite("all", [scored("passed", 80), scored("failed", 40), errored("agent")]),
    );

    expect(text).toMatch(/60/);
    expect(text).toMatch(/2 of 3/);
  });
});

describe("formatRunSummary", () => {
  it("shows the status, the category scores, the overall and what the run cost", () => {
    const text = formatRunSummary(
      benchReport({
        taskId: "landing-page",
        status: "failed",
        score: 17,
        categories: [
          { category: "functional", score: 0, effectiveWeight: 83.3, checks: 1 },
          { category: "code", score: 100, effectiveWeight: 16.7, checks: 1 },
        ],
        checks: [
          benchCheck({ checkId: "builds", build: true, outcome: "failed", detail: "exit 1" }),
        ],
        metrics: {
          toolCalls: 7,
          toolFailures: 1,
          commands: 2,
          filesChanged: 3,
          turns: { started: 1, completed: 1, failed: 0, cancelled: 0 },
          tokens: { inputTokens: 12_000, outputTokens: 900 },
          turnDurationMs: 42_000,
        },
      }),
    );

    expect(text).toMatch(/landing-page/);
    expect(text).toMatch(/failed/i);
    expect(text).toMatch(/functional/);
    expect(text).toMatch(/17/);
    expect(text).toMatch(/turn time 42\.0s/);
    expect(text).toMatch(/7/);
    expect(text).toMatch(/12,000 in \/ 900 out/);
    // The failing check is named, so a score is never handed over unexplained.
    expect(text).toMatch(/builds/);
  });

  it("counts every check, so a category score can be read against what it was over", () => {
    const text = formatRunSummary(
      benchReport({
        checks: [
          benchCheck({ checkId: "builds", build: true }),
          benchCheck({ checkId: "lints", category: "code", outcome: "failed", detail: "exit 1" }),
        ],
      }),
    );

    expect(text).toMatch(/checks: 1 passed, 1 failed/);
  });

  it("prints no error kind for a cancelled run, because cancellation is not one", () => {
    // ADR-0002: a run somebody stopped is not an observation. `(null)` would read as a kind.
    const text = formatRunSummary(cancelled());

    expect(text).toMatch(/CANCELLED no score/);
    expect(text).not.toMatch(/null/);
  });

  it("says why an errored run has no score, rather than printing one", () => {
    const text = formatRunSummary(errored("sandbox"));

    expect(text).toMatch(/errored/i);
    expect(text).toMatch(/sandbox/);
    expect(text).not.toMatch(/\b0\/100\b/);
  });

  it("prints the figures the event stream could not supply as absent, not as zero", () => {
    // A failed turn reports no usage and no duration. Zero would be a measurement; these are
    // absences, and a reader has to be able to tell them apart.
    const text = formatRunSummary(errored("agent"));

    expect(text).toMatch(/turn time —/);
    expect(text).toMatch(/tokens —/);
  });
});
