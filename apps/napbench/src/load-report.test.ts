/**
 * Reading a report back off disk, by whichever of the two names somebody has to hand.
 *
 * Free and deterministic: one temporary directory, no network and no sandbox.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialiseBenchReport } from "@nap/bench/report";
import { benchReport } from "@nap/bench/testing/bench-report";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBenchReport } from "./load-report.ts";
import { writeBenchReport } from "./write-report.ts";

let resultsDir: string;

beforeEach(() => {
  resultsDir = mkdtempSync(join(tmpdir(), "napbench-load-"));
});

afterEach(() => {
  rmSync(resultsDir, { recursive: true, force: true });
});

async function loaded(reference: string) {
  const result = await loadBenchReport(resultsDir, reference);
  if (!result.ok) throw new Error(`expected a report, got: ${result.error}`);
  return result.value;
}

async function refused(reference: string): Promise<string> {
  const result = await loadBenchReport(resultsDir, reference);
  if (result.ok) throw new Error("expected the reference to be refused");
  return result.error;
}

describe("loadBenchReport", () => {
  it("finds a report by run id, without being told the task", async () => {
    // The id is what a summary prints and therefore what somebody copies; making them also
    // remember which task it was would defeat the point.
    const report = benchReport({ taskId: "todo-crud" });
    await writeBenchReport(resultsDir, report);

    expect(await loaded(report.runId)).toEqual(report);
  });

  it("finds a report by path, so a report from anywhere can be compared", async () => {
    const report = benchReport({ taskId: "landing-page" });
    const path = await writeBenchReport(resultsDir, report);

    expect(await loaded(path)).toEqual(report);
  });

  it("says a run id it cannot find is not there, rather than throwing", async () => {
    expect(await refused("3f2a1c4e-0000-4000-8000-00000000dead")).toMatch(/no report/i);
  });

  it("refuses a file that is not a report, rather than comparing nonsense", async () => {
    // A malformed report is untrusted input: it is read back months later, and a comparison
    // against a half-parsed one would be worse than a refusal.
    const path = join(resultsDir, "broken.json");
    writeFileSync(path, '{"runId":"not a uuid"}\n', "utf8");

    expect(await refused(path)).toMatch(/runId/);
  });

  it("refuses a file that is not even JSON", async () => {
    const path = join(resultsDir, "notjson.json");
    writeFileSync(path, "this is not json", "utf8");

    expect(await refused(path)).toMatch(/could not read|not valid JSON/i);
  });

  it("does not mistake a trajectory for the report beside it", async () => {
    // Both files carry the same run id in their names, and only one of them is a report.
    const report = benchReport();
    await writeBenchReport(resultsDir, report);
    writeFileSync(
      join(resultsDir, `${report.taskId}-${report.runId}.trajectory.json`),
      serialiseBenchReport(report),
      "utf8",
    );

    expect((await loaded(report.runId)).runId).toBe(report.runId);
  });
});
