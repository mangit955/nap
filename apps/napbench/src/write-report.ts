/**
 * Putting a report on disk — the one part of producing one that touches a filesystem, and
 * therefore the one part that lives in the app rather than in `@nap/bench`.
 *
 * Named by task *and* run id. The task id makes a directory listing readable at a glance; the
 * run id is what keeps two runs of the same task from overwriting each other, which is the
 * whole point of running one twice.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BenchReport, serialiseBenchReport } from "@nap/bench/report";

/** Where a report goes, as a pure function, so a caller can print the path before writing. */
export function reportPath(resultsDir: string, report: BenchReport): string {
  return join(resultsDir, `${report.taskId}-${report.runId}.json`);
}

/** Writes the report and returns where it went, creating the directory if it is missing. */
export async function writeBenchReport(resultsDir: string, report: BenchReport): Promise<string> {
  await mkdir(resultsDir, { recursive: true });
  const path = reportPath(resultsDir, report);
  await writeFile(path, serialiseBenchReport(report), "utf8");
  return path;
}
