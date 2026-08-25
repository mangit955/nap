/**
 * One trial of one task, for an external harness to drive — and the verifier that turns the
 * report it left behind into a reward, or into nothing.
 *
 * `bun run napbench:trial run --task=reading-list --job-dir=/jobs/t1/agent -- --real`
 * `bun run napbench:trial verify --job-dir=/logs/agent --reward-dir=/logs/verifier`
 *
 * **`run` executes on the host and shells out to `napbench`.** Not a second composition root:
 * the benchmark's own script is the only place a real sandbox, a real model, a real browser
 * and a real judge meet the evaluator, and a trial that composed those itself would be a
 * second way to run the thing being measured. What this adds is the job directory — the run's
 * artefacts land in the directory the harness gave it, under fixed names, instead of in the
 * shared results folder.
 *
 * **A trial always leaves a report.** A run the benchmark crashed on writes one here, with the
 * status and the error kind that say so, because a job directory holding nothing is
 * indistinguishable from a trial that never started. The reward is a lossy projection of that
 * report and is allowed to be absent; the report is not.
 *
 * **`verify` refuses to invent a reward.** It calls `rewardFor`, and when that returns nothing
 * it writes no file and exits non-zero. See `packages/bench/src/reward.ts` for why an errored
 * run is not a zero, and `docs/adr/0014` for why this is the only thing the harness gets.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CATEGORY_WEIGHTS } from "@nap/bench/category";
import { deriveRunMetrics } from "@nap/bench/metrics";
import { evaluatorErrorReport, parseBenchReport, serialiseBenchReport } from "@nap/bench/report";
import { RESULTS_DIR_ENV } from "../src/results-dir.ts";
import {
  napbenchArgv,
  parseTrialArgs,
  rewardDecisionFor,
  rewardPath,
  TRIAL_USAGE,
  type TrialRun,
  type TrialVerify,
  trialArtefacts,
  trialPaths,
} from "../src/trial.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const NAPBENCH_SCRIPT = join(REPO_ROOT, "apps", "napbench", "scripts", "napbench.ts");

const parsed = parseTrialArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`${parsed.error}\n\n${TRIAL_USAGE}`);
  process.exit(1);
}

const command = parsed.value;
process.exit(command.kind === "run" ? await runTrial(command) : await verifyTrial(command));

/**
 * Runs the benchmark once, into the job directory, and normalises what it left there.
 *
 * Exits 0 whenever a report exists, whatever that report says. "The model scored badly" and
 * "the sandbox never came up" are both trials that ran; the reward is where the difference is
 * expressed, and the verifier is what expresses it. A non-zero here means this entrypoint
 * itself could not produce a report, which is the only failure it owns.
 */
async function runTrial(command: TrialRun): Promise<number> {
  const paths = trialPaths(command.jobDir);
  await mkdir(command.jobDir, { recursive: true });

  const log = createWriteStream(paths.log, { flags: "w" });
  const exitCode = await spawnNapbench(napbenchArgv(command), command.jobDir, log);
  log.end();

  // The benchmark names its files by task and run id, which is right for an archive shared by
  // every run this checkout has performed and wrong for a directory holding exactly one trial:
  // a harness reads `report.json`. Renamed rather than copied so nothing is left behind for a
  // later trial to find and mistake for its own.
  const produced = trialArtefacts(command.taskId, await readdir(command.jobDir).catch(() => []));
  if (produced.report !== undefined) {
    await rename(join(command.jobDir, produced.report), paths.report);
    if (produced.trajectory !== undefined) {
      await rename(join(command.jobDir, produced.trajectory), paths.trajectory);
    }
    console.log(`trial report: ${paths.report}`);
    return 0;
  }

  // Nothing was written, so the benchmark died before it could write one — a mistyped task
  // id, a missing credential, a crash in the runner. Recorded as the evaluator's failure,
  // which is what it is, and never as a score.
  await writeFile(
    paths.report,
    serialiseBenchReport(
      evaluatorErrorReport({
        runId: crypto.randomUUID(),
        taskId: command.taskId,
        // No session ever existed; a fabricated id would point at nothing, which is honest
        // only because every other field here says the run never happened.
        sessionId: crypto.randomUUID(),
        weights: DEFAULT_CATEGORY_WEIGHTS,
        metrics: deriveRunMetrics([]),
      }),
    ),
    "utf8",
  );

  console.error(
    `napbench exited ${exitCode} without writing a report — recorded as an evaluator error at ` +
      `${paths.report}. Its output is in ${paths.log}.`,
  );
  return 0;
}

/** Reads the report the trial left, and writes the reward it projects to — or none. */
async function verifyTrial(command: TrialVerify): Promise<number> {
  const paths = trialPaths(command.jobDir);

  let body: string;
  try {
    body = await readFile(paths.report, "utf8");
  } catch {
    // A missing report is not an unmeasured run: it means the trial never got as far as
    // writing one, which is a broken harness rather than a benchmark result.
    console.error(`no report at ${paths.report} — nothing to verify`);
    return 1;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    // A half-written report — the trial was killed mid-write, the disk filled. Reported as a
    // broken artefact rather than allowed to throw: a stack trace out of the verifier reads as
    // a bug in the verifier, and the exit code is what the harness acts on either way.
    console.error(`the report at ${paths.report} is not valid JSON — nothing to verify`);
    return 1;
  }

  const report = parseBenchReport(parsedJson);
  if (!report.ok) {
    console.error(`the report at ${paths.report} could not be read — ${report.error}`);
    return 1;
  }

  const decision = rewardDecisionFor(report.value);
  if (!decision.written) {
    // The rule the whole migration turns on: no file, non-zero exit, and never a zero.
    console.error(`no reward written — ${decision.reason}`);
    return 1;
  }

  await mkdir(command.rewardDir, { recursive: true });
  const path = rewardPath(command.rewardDir);
  await writeFile(path, decision.body, "utf8");
  console.log(`reward: ${path}`);
  return 0;
}

/** Runs `napbench` as a child, streaming its output to the terminal and to the trial log. */
function spawnNapbench(
  args: readonly string[],
  jobDir: string,
  log: NodeJS.WritableStream,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", NAPBENCH_SCRIPT, ...args], {
      cwd: REPO_ROOT,
      // The results directory is the job directory, so the benchmark writes its report,
      // its trajectory and its screenshots where the harness will mount them from.
      env: { ...process.env, [RESULTS_DIR_ENV]: jobDir },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });

    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
