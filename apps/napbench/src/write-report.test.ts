import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CATEGORY_WEIGHTS } from "@nap/bench/category";
import { type BenchReport, parseBenchReport } from "@nap/bench/report";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportPath, writeBenchReport } from "./write-report.ts";

const report: BenchReport = {
  runId: "3f2a1c4e-0000-4000-8000-000000000001",
  taskId: "landing-page",
  sessionId: "3f2a1c4e-0000-4000-8000-000000000002",
  turnId: "3f2a1c4e-0000-4000-8000-000000000003",
  status: "passed",
  score: 100,
  categories: [{ category: "functional", score: 100, effectiveWeight: 100, checks: 1 }],
  weights: DEFAULT_CATEGORY_WEIGHTS,
  checks: [
    {
      checkId: "build",
      kind: "command",
      category: "functional",
      weight: 1,
      required: false,
      outcome: "passed",
      detail: "exit 0",
    },
  ],
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "napbench-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeBenchReport", () => {
  it("writes a report that parses back to what went in", async () => {
    const path = await writeBenchReport(dir, report);

    const readBack = parseBenchReport(JSON.parse(readFileSync(path, "utf8")));
    expect(readBack.ok).toBe(true);
    if (readBack.ok) expect(readBack.value).toEqual(report);
  });

  it("creates the results directory when it is not there", async () => {
    // The directory is gitignored, so a fresh checkout does not have one — and a benchmark
    // that failed at the last step because of that would have spent the money already.
    const path = await writeBenchReport(join(dir, "nested", "deeper"), report);
    expect(readFileSync(path, "utf8")).toContain("landing-page");
  });

  it("names the file by run id, so two runs of one task cannot overwrite each other", async () => {
    const other = { ...report, runId: "3f2a1c4e-0000-4000-8000-00000000000f" };

    const first = await writeBenchReport(dir, report);
    const second = await writeBenchReport(dir, other);

    expect(first).not.toBe(second);
    expect(readFileSync(first, "utf8")).toContain(report.runId);
    expect(readFileSync(second, "utf8")).toContain(other.runId);
  });

  it("puts the task id in the path, so a directory listing is readable", () => {
    expect(reportPath("/results", report)).toContain("landing-page");
    expect(reportPath("/results", report)).toContain(report.runId);
  });
});
