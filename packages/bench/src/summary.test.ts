import { describe, expect, it } from "vitest";
import { DEFAULT_CATEGORY_WEIGHTS } from "./category.ts";
import type { ErrorKind } from "./error-kind.ts";
import type { BenchReport } from "./report.ts";
import type { RunStatus } from "./status.ts";
import { formatRunSummary, formatSuiteSummary, summariseSuite } from "./summary.ts";
import { VISUAL_NOT_RUN } from "./visual.ts";

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const TURN_ID = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";

function report(overrides: Partial<BenchReport> = {}): BenchReport {
  return {
    runId: crypto.randomUUID(),
    taskId: "todo-crud",
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    status: "passed",
    errorKind: null,
    gates: [],
    scoreCap: null,
    score: 100,
    categories: [],
    weights: DEFAULT_CATEGORY_WEIGHTS,
    checks: [],
    metrics: {
      toolCalls: 0,
      toolFailures: 0,
      commands: 0,
      filesChanged: 0,
      turns: { started: 1, completed: 1, failed: 0, cancelled: 0 },
    },
    screenshots: [],
    visual: VISUAL_NOT_RUN,
    ...overrides,
  };
}

function scored(status: RunStatus, score: number): BenchReport {
  return report({ status, score });
}

function errored(errorKind: ErrorKind): BenchReport {
  return report({ status: "errored", score: null, errorKind });
}

const cancelled = (): BenchReport => report({ status: "cancelled", score: null });

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
      report({
        taskId: "landing-page",
        status: "failed",
        score: 17,
        categories: [
          { category: "functional", score: 0, effectiveWeight: 83.3, checks: 1 },
          { category: "code", score: 100, effectiveWeight: 16.7, checks: 1 },
        ],
        checks: [
          {
            checkId: "builds",
            kind: "command",
            category: "functional",
            weight: 1,
            required: false,
            build: true,
            outcome: "failed",
            detail: "exit 1",
          },
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
    expect(text).toMatch(/42\.0s/);
    expect(text).toMatch(/7/);
    expect(text).toMatch(/12,000 in \/ 900 out/);
    // The failing check is named, so a score is never handed over unexplained.
    expect(text).toMatch(/builds/);
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

    expect(text).toMatch(/duration —/);
    expect(text).toMatch(/tokens —/);
  });
});
