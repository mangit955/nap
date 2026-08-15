/**
 * Finding a report again, given whichever of its two names somebody has to hand.
 *
 * A run id is what the summary printed and therefore what gets copied out of a terminal; a path
 * is what somebody has when the report came from somewhere else — an archive, a colleague, a
 * directory that has since been moved. Both resolve to the same thing, and neither is allowed
 * to produce a half-read report: a comparison is arithmetic on archived JSON, so what comes off
 * the disk is untrusted input and is validated before anything is subtracted from it.
 *
 * The filesystem half of comparison, and therefore the half that lives in the app rather than
 * in `@nap/bench`. See `docs/adr/0001`.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type BenchReport, parseBenchReport } from "@nap/bench/report";
import type { Result } from "@nap/shared/result";

/**
 * Reads the report a reference names, or explains why it could not.
 *
 * Every failure is returned rather than thrown, because the caller is a CLI: "there is no run
 * with that id" is an ordinary thing to type wrong, and a stack trace naming `readFile` is a
 * worse answer than a sentence.
 */
export async function loadBenchReport(
  resultsDir: string,
  reference: string,
): Promise<Result<BenchReport, string>> {
  const path = looksLikePath(reference)
    ? { ok: true as const, value: reference }
    : await findByRunId(resultsDir, reference);
  if (!path.ok) return path;

  let body: string;
  try {
    body = await readFile(path.value, "utf8");
  } catch (error) {
    return { ok: false, error: `could not read ${path.value}: ${messageOf(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: `${path.value} is not valid JSON` };
  }

  const report = parseBenchReport(parsed);
  if (!report.ok) return { ok: false, error: `${path.value} is not a report: ${report.error}` };

  return report;
}

/**
 * Whether this is a place rather than a name.
 *
 * A run id is a uuid, which contains neither of these, so the two references cannot be
 * confused — and a path is checked for first so that a file literally named after a uuid in
 * some other directory is still readable by pointing at it.
 */
function looksLikePath(reference: string): boolean {
  return reference.includes("/") || reference.endsWith(".json");
}

/**
 * The one report in the results directory whose name ends with this run id.
 *
 * Matched on the suffix rather than by parsing the name, because the prefix is the task id and
 * the whole point of searching by run id is not having to remember it. The trajectory beside it
 * shares both ids and is excluded by the same suffix — it ends `.trajectory.json`.
 */
async function findByRunId(resultsDir: string, runId: string): Promise<Result<string, string>> {
  let entries: string[];
  try {
    entries = await readdir(resultsDir);
  } catch (error) {
    return { ok: false, error: `could not read ${resultsDir}: ${messageOf(error)}` };
  }

  const found = entries.find((entry) => entry.endsWith(`-${runId}.json`));
  if (found === undefined) {
    return { ok: false, error: `no report for run ${runId} in ${resultsDir}` };
  }

  return { ok: true, value: join(resultsDir, found) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
