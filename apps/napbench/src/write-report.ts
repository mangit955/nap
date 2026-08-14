/**
 * Putting a run's two artefacts on disk — the report and the trajectory it was derived from.
 * The one part of producing them that touches a filesystem, and therefore the one part that
 * lives in the app rather than in `@nap/bench`.
 *
 * Both are named by task *and* run id. The task id makes a directory listing readable at a
 * glance; the run id is what keeps two runs of the same task from overwriting each other,
 * which is the whole point of running one twice — and what pairs a report with its own
 * trajectory rather than one from a neighbouring run.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BenchReport, serialiseBenchReport } from "@nap/bench/report";
import { type BenchTrajectory, serialiseBenchTrajectory } from "@nap/bench/trajectory";

/** Where a report goes, as a pure function, so a caller can print the path before writing. */
export function reportPath(resultsDir: string, report: BenchReport): string {
  return join(resultsDir, `${report.taskId}-${report.runId}.json`);
}

/** Writes the report and returns where it went, creating the directory if it is missing. */
export async function writeBenchReport(resultsDir: string, report: BenchReport): Promise<string> {
  return write(resultsDir, reportPath(resultsDir, report), serialiseBenchReport(report));
}

/**
 * Where a trajectory goes: beside its report, sharing its name.
 *
 * The two files are one record and nothing links them but this convention — a report does
 * not carry a path to its trajectory, because a path baked into an archived artefact is
 * wrong the first time somebody moves the directory. Sharing task id and run id means the
 * pair can be found by name from either side.
 */
export function trajectoryPath(resultsDir: string, trajectory: BenchTrajectory): string {
  return join(resultsDir, `${trajectory.taskId}-${trajectory.runId}.trajectory.json`);
}

/** Writes the run's event stream, whole, beside the report derived from it. */
export async function writeBenchTrajectory(
  resultsDir: string,
  trajectory: BenchTrajectory,
): Promise<string> {
  return write(
    resultsDir,
    trajectoryPath(resultsDir, trajectory),
    serialiseBenchTrajectory(trajectory),
  );
}

/**
 * The half of writing an artefact that is the same for both: make the directory, then the
 * file. The results directory is gitignored, so a fresh checkout does not have one — and a
 * benchmark that failed at the last step for want of a `mkdir` has already spent the money.
 */
async function write(resultsDir: string, path: string, body: string): Promise<string> {
  await mkdir(resultsDir, { recursive: true });
  await writeFile(path, body, "utf8");
  return path;
}
