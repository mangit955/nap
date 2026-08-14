import { describe, expect, it } from "vitest";
import { type BenchReport, parseBenchReport, serialiseBenchReport } from "./report.ts";

const report: BenchReport = {
  runId: "3f2a1c4e-0000-4000-8000-000000000001",
  taskId: "landing-page",
  sessionId: "3f2a1c4e-0000-4000-8000-000000000002",
  turnId: "3f2a1c4e-0000-4000-8000-000000000003",
  status: "passed",
  score: 100,
  checks: [{ checkId: "build", kind: "command", passed: true, detail: "exit 0" }],
};

describe("a report", () => {
  it("round-trips through serialisation unchanged", () => {
    const parsed = parseBenchReport(JSON.parse(serialiseBenchReport(report)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(report);
  });

  it("keeps the run id and the session id apart", () => {
    // The word "run" collides: a NapBench run contains a Nap session, which contains
    // turns. A report carrying one id called "id" would make that ambiguous forever.
    // See CONTEXT.md, which calls this out as the collision to guard.
    expect(report.runId).not.toBe(report.sessionId);
    const parsed = parseBenchReport(JSON.parse(serialiseBenchReport(report)));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.runId).toBe(report.runId);
    expect(parsed.value.sessionId).toBe(report.sessionId);
  });

  it("round-trips an errored run, which has no score and no turn", () => {
    // Absent rather than zero: a run whose turn never completed produced no observation,
    // and a zero would be indistinguishable from an agent that built something broken.
    const errored: BenchReport = {
      ...report,
      status: "errored",
      score: null,
      turnId: null,
      checks: [],
    };
    const parsed = parseBenchReport(JSON.parse(serialiseBenchReport(errored)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(errored);
  });

  it("is written as indented JSON, so a committed report diffs line by line", () => {
    expect(serialiseBenchReport(report)).toContain("\n  ");
  });

  it("refuses a report whose score is not a percentage", () => {
    expect(parseBenchReport({ ...report, score: 140 }).ok).toBe(false);
    expect(parseBenchReport({ ...report, score: -1 }).ok).toBe(false);
  });

  it("refuses a passed run with no score", () => {
    // Passed and failed are results and both carry a score; only errored may omit one.
    expect(parseBenchReport({ ...report, score: null }).ok).toBe(false);
  });

  it("refuses an unknown status", () => {
    // Deliberately not "cancelled": that is a real status in the design and will be accepted
    // one day, so asserting its rejection here would pin a decision that has to change.
    expect(parseBenchReport({ ...report, status: "exploded" }).ok).toBe(false);
  });
});
