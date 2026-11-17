/**
 * Writes the report of one Harbor job of Nap on Terminal-Bench: `report.md` and `report.json`.
 *
 *   bun run packages/runtime/scripts/harbor-report.ts <job-dir> [<out-dir>]
 *
 * `<job-dir>` is the job's own directory (`<jobs-dir>/<job-name>`), holding one subdirectory per
 * trial; `<out-dir>` defaults to it. Prints only where the files went: the benchmark workflow runs
 * this in public logs, and the results belong in its artifact. The reading is `harbor-report.ts`
 * in `src`; see harbor/README.md, "Scoring a task set".
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJob, renderReport, summarise } from "../src/harbor-report.ts";

const [jobDir, out] = process.argv.slice(2);
if (jobDir === undefined || process.argv.length > 4) {
  console.error("Usage: bun run packages/runtime/scripts/harbor-report.ts <job-dir> [<out-dir>]");
  process.exit(2);
}

const { trials, dataset } = readJob(resolve(jobDir));
if (trials.length === 0) {
  console.error(
    `No trials in ${jobDir}: expected one subdirectory per trial, each with result.json.`,
  );
  process.exit(1);
}

const outDir = out ?? jobDir;
const report = summarise(trials, dataset);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "report.md"), renderReport(report));
writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.error(
  `Report of ${trials.length} trials written to ${join(outDir, "report.md")} and report.json`,
);
