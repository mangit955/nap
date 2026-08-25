/**
 * One trial, as an external harness sees it: run a single task into a job directory, then
 * project the report that came out of it into a reward — or refuse to.
 *
 * Everything here is a decision rather than an effect, which is the split `docs/adr/0001`
 * draws and the reason a harness adapter can be thin. The harness (Harbor) contributes a job
 * layout, fan-out and a registry; it contributes no check, no gate, no score and no
 * attribution. The two rules worth testing are both here: which command line runs a trial,
 * and when a trial produces no reward at all.
 *
 * **The refusal is the point.** `rewardFor` returns nothing for a run that measured nothing,
 * and this turns that into "write no file and exit non-zero" rather than into a zero. A zero
 * is a claim about a model; an errored trial is a claim about an afternoon. See
 * `packages/bench/src/reward.ts` and `docs/NAPBENCH.md`.
 */

import { join } from "node:path";
import type { BenchReport } from "@nap/bench/report";
import { rewardFor } from "@nap/bench/reward";
import type { Result } from "@nap/shared/result";

/** The report a trial always leaves behind, measured or not. */
export const TRIAL_REPORT_FILE = "report.json";
/** The event stream the report was derived from, beside it. */
export const TRIAL_TRAJECTORY_FILE = "trajectory.json";
/** Everything the run printed, so a trial nobody watched can still be read afterwards. */
export const TRIAL_LOG_FILE = "trial.log";
/** The flat `name -> number` file the harness reads a reward out of. */
export const TRIAL_REWARD_FILE = "reward.json";

export const TRIAL_USAGE = [
  "Usage: bun run napbench:trial run --task=<id> --job-dir=<dir> [-- <napbench flags>]",
  "       bun run napbench:trial verify --job-dir=<dir> --reward-dir=<dir>",
  "",
  "  run       Runs one task, writing report.json, trajectory.json and trial.log into the",
  "            job directory. Flags after `--` are passed to napbench verbatim, including",
  "            --real, which is what makes a trial cost money.",
  "  verify    Reads the job directory's report and writes reward.json into the reward",
  "            directory. A trial that measured nothing writes no file and exits non-zero.",
].join("\n");

export type TrialRun = {
  kind: "run";
  taskId: string;
  jobDir: string;
  /** Passed to `napbench` untouched, so this entrypoint owns no second flag table. */
  napbenchFlags: readonly string[];
};

export type TrialVerify = {
  kind: "verify";
  jobDir: string;
  /** Kept apart from the job directory because the harness mounts them separately. */
  rewardDir: string;
};

export type TrialCommand = TrialRun | TrialVerify;

/**
 * Parses a trial's command line.
 *
 * Deliberately tiny: two subcommands, two or three flags, and everything the benchmark itself
 * understands passed through after `--`. A second copy of `napbench`'s flag table here would
 * be a place for the two to disagree about which of them means "spend money".
 */
export function parseTrialArgs(argv: readonly string[]): Result<TrialCommand, string> {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined) return { ok: false, error: "no subcommand — expected run|verify" };

  const separator = rest.indexOf("--");
  const flags = separator === -1 ? rest : rest.slice(0, separator);
  const passthrough = separator === -1 ? [] : rest.slice(separator + 1);

  const named = new Map<string, string>();
  for (const flag of flags) {
    const match = /^--([a-z-]+)=(.+)$/.exec(flag);
    const [, key, value] = match ?? [];
    if (key === undefined || value === undefined) {
      return { ok: false, error: `unknown argument: ${flag}` };
    }
    named.set(key, value);
  }

  if (subcommand === "run") {
    const taskId = named.get("task");
    const jobDir = named.get("job-dir");
    if (taskId === undefined) return { ok: false, error: "run needs --task=<id>" };
    if (jobDir === undefined) return { ok: false, error: "run needs --job-dir=<dir>" };

    const unknown = unknownFlags(named, ["task", "job-dir"]);
    // Named rather than counted, and with the reason: the flag most likely to arrive here is
    // `--real` written on the wrong side of the separator, which is the one that spends money.
    if (unknown !== undefined) {
      return { ok: false, error: `${unknown} — napbench's own flags go after \`--\`` };
    }

    return { ok: true, value: { kind: "run", taskId, jobDir, napbenchFlags: passthrough } };
  }

  if (subcommand === "verify") {
    if (passthrough.length > 0) return { ok: false, error: "verify takes no napbench flags" };
    const jobDir = named.get("job-dir");
    const rewardDir = named.get("reward-dir");
    if (jobDir === undefined) return { ok: false, error: "verify needs --job-dir=<dir>" };
    if (rewardDir === undefined) return { ok: false, error: "verify needs --reward-dir=<dir>" };

    const unknown = unknownFlags(named, ["job-dir", "reward-dir"]);
    if (unknown !== undefined) return { ok: false, error: unknown };

    return { ok: true, value: { kind: "verify", jobDir, rewardDir } };
  }

  return { ok: false, error: `unknown subcommand: ${subcommand} — expected run|verify` };
}

/** The flags a subcommand does not have, as the sentence to refuse them with. */
function unknownFlags(named: Map<string, string>, allowed: readonly string[]): string | undefined {
  const unknown = [...named.keys()].filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return undefined;

  return `unknown flag(s): ${unknown.map((key) => `--${key}`).join(", ")}`;
}

/** Where a trial's three artefacts live, given the directory the harness handed it. */
export function trialPaths(jobDir: string): {
  report: string;
  trajectory: string;
  log: string;
} {
  return {
    report: join(jobDir, TRIAL_REPORT_FILE),
    trajectory: join(jobDir, TRIAL_TRAJECTORY_FILE),
    log: join(jobDir, TRIAL_LOG_FILE),
  };
}

/** Where the reward goes, when there is one. */
export function rewardPath(rewardDir: string): string {
  return join(rewardDir, TRIAL_REWARD_FILE);
}

/**
 * The argument list a trial runs the benchmark with: whatever it was given, then the task.
 *
 * One task, never a suite — fan-out is the harness's job, and a trial that ran four tasks
 * would produce four reports and one reward, which is a shape nothing downstream can read.
 */
export function napbenchArgv(command: TrialRun): string[] {
  return [...command.napbenchFlags, command.taskId];
}

/** A run id, as the benchmark writes it into a filename. */
const RUN_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * The report and trajectory a finished run left in the job directory.
 *
 * Matched on the benchmark's own naming — `<task>-<run>.json` beside
 * `<task>-<run>.trajectory.json` — rather than parsed out of the run's stdout, which would make
 * the layout depend on a log line.
 *
 * **The run id has to be matched, not skipped over.** A run also writes a sidecar per
 * screenshot, named `<task>-<run>-<subject>.png.json`, into the same directory. A looser match
 * on "starts with the task id and ends in .json" picks one of those up, and the trial then files
 * a screenshot descriptor as its report — a good run, possibly a paid one, recorded as a failed
 * trial because the verifier could not parse it.
 */
export function trialArtefacts(
  taskId: string,
  entries: readonly string[],
): { report?: string; trajectory?: string } {
  // The id is a task's own, from a hand-written module rather than from input, but it reaches a
  // regular expression here and a `.` in one would otherwise match any character.
  const id = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const report = entries.find((entry) => new RegExp(`^${id}-${RUN_ID}\\.json$`).test(entry));
  const trajectory = entries.find((entry) =>
    new RegExp(`^${id}-${RUN_ID}\\.trajectory\\.json$`).test(entry),
  );

  return {
    ...(report === undefined ? {} : { report }),
    ...(trajectory === undefined ? {} : { trajectory }),
  };
}

/**
 * What the verifier should do with a finished report: write this, or write nothing.
 *
 * A returned decision rather than a `writeFile` call, so the rule that decides whether a
 * benchmark run is worth anything is unit-tested rather than observed by running one.
 */
export type RewardDecision = { written: true; body: string } | { written: false; reason: string };

export function rewardDecisionFor(report: BenchReport): RewardDecision {
  const reward = rewardFor(report);
  if (reward === undefined) {
    return {
      written: false,
      // Both facts, because they answer different questions: the status says the trial did not
      // measure anything, and the error kind says whose fault that was — and neither is the
      // model's until the kind says `agent`.
      reason:
        `this run measured nothing (status ${report.status}` +
        `${report.errorKind === null ? "" : `, ${report.errorKind}`}), so it has no reward`,
    };
  }

  return { written: true, body: `${JSON.stringify(reward, null, 2)}\n` };
}
