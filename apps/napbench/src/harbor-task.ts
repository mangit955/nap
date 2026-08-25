/**
 * What one benchmark task looks like once an external harness has to run it.
 *
 * Harbor's unit of work is a directory — an instruction, a container definition, a verifier
 * and some metadata — and this turns a `BenchTask` into that directory's contents. Generated
 * rather than hand-written, because the registry it produces is a projection of
 * `@nap/bench/suite` and a hand-maintained copy would be a second list of what the benchmark
 * measures, drifting quietly from the first.
 *
 * **Everything here is layout and nothing here is evaluation.** No check, no gate, no weight
 * and no score crosses into the generated tree: the instruction names a task, the Dockerfile
 * builds an empty image, and the verifier shells into this repo's own entrypoint. What the
 * harness contributes is fan-out, a job directory and a registry — see `docs/adr/0014`.
 *
 * **The container is near-vestigial on purpose.** The trial runs on the host, so host Chrome,
 * the host `.env` and host E2B egress all keep working exactly as they do under `bun run
 * napbench`. The image exists because the harness needs an environment to mount a job
 * directory into and to run a verifier in; it holds a Bun runtime and one bundled file.
 */

import type { BenchTask } from "@nap/bench/task";

/** Where the generated registry goes, relative to the repository root. */
export const HARBOR_TASKS_DIR = "harbor/tasks";

/** The bundled verifier the generated container runs, written into each task's `tests/`. */
export const HARBOR_VERIFIER_FILE = "verify.js";

/**
 * The line that tells the agent which benchmark task a trial is.
 *
 * The instruction is the only channel the harness gives an agent that varies per task, so the
 * task id travels in it — as a comment, because a reader of the rendered instruction should
 * see prose and the agent should not have to parse prose. `napbench_harbor.trial` holds the
 * same pattern on the Python side and is tested against a generated instruction.
 */
export function taskMarker(taskId: string): string {
  return `<!-- napbench-task: ${taskId} -->`;
}

/**
 * The image a trial's environment is built from.
 *
 * Bun because the verifier is this repo's code, Alpine because nothing else is needed: the
 * agent that does the work never enters this container. A Dockerfile that installed the
 * project would be pretending to an isolation the design does not claim.
 */
export const HARBOR_DOCKERFILE = [
  "# The trial runs on the host, not in here — see docs/adr/0014. This image exists so the",
  "# harness has somewhere to mount the job directory and run the verifier, and the verifier",
  "# is one bundled file of this repository's own code. Nothing else belongs in it.",
  "FROM oven/bun:1.3.13-alpine",
  "",
  "WORKDIR /app",
  "",
].join("\n");

/**
 * The verifier the harness runs once a trial is over.
 *
 * It re-emits a report this repository already wrote: `verify` reads the job directory, calls
 * `rewardFor`, and either writes `reward.json` or writes nothing and exits non-zero. The exit
 * code is propagated rather than swallowed, because "this trial has no reward" is the answer
 * and a shell that always exits 0 would turn it into "this trial scored nothing".
 */
export const HARBOR_TEST_SCRIPT = [
  "#!/bin/sh",
  "# Re-emits the report the trial already wrote. Owns no check, no gate and no score: the",
  "# reward rule is `rewardFor` in packages/bench/src/reward.ts, bundled into verify.js.",
  "set -e",
  "",
  `bun /tests/${HARBOR_VERIFIER_FILE} verify --job-dir=/logs/agent --reward-dir=/logs/verifier`,
  "",
].join("\n");

/** How long a trial is given before the harness stops it, in seconds. */
export const HARBOR_AGENT_TIMEOUT_SEC = 3_600;

/** How long the verifier is given. It reads one file and writes one file. */
export const HARBOR_VERIFIER_TIMEOUT_SEC = 120;

/**
 * What the harness is told about a task.
 *
 * Deliberately thin. The environment's resources describe a container that runs a verifier,
 * not a container that builds an application — the sandbox that does that is E2B's, reached
 * from the host, and no figure here has any bearing on it.
 */
export function harborTaskToml(task: BenchTask): string {
  return [
    'schema_version = "1.4"',
    "",
    "[task]",
    `name = "nap/${task.id}"`,
    'version = "1.0.0"',
    "authors = []",
    "keywords = []",
    "",
    "[metadata]",
    // The task's name and nothing else. Anything about how it is *scored* would be a second
    // statement of the scoring model, living in a generated directory no gate here covers —
    // and the report already says which arithmetic produced its number.
    `description = "${tomlString(task.name)}"`,
    "",
    "[agent]",
    `timeout_sec = ${HARBOR_AGENT_TIMEOUT_SEC}.0`,
    "",
    "[verifier]",
    `timeout_sec = ${HARBOR_VERIFIER_TIMEOUT_SEC}.0`,
    "",
    "[environment]",
    "build_timeout_sec = 600.0",
    "cpus = 1",
    "memory_mb = 1024",
    "storage_mb = 2048",
    "gpus = 0",
    "mcp_servers = []",
    "",
  ].join("\n");
}

/** A string as TOML spells it. A task name is ours, but a stray quote would emit a broken file. */
function tomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * What the agent is handed when the harness starts a trial.
 *
 * The prompts are reproduced for a person reading the registry, and are *not* how the agent
 * learns them: the trial entrypoint reads the task out of `@nap/bench/suite`, so what the
 * model is asked comes from the same place it comes from under `bun run napbench`. Only the
 * marker is load-bearing.
 */
export function harborInstruction(task: BenchTask): string {
  return [
    `# ${task.name}`,
    "",
    taskMarker(task.id),
    "",
    "This trial runs NapBench task `" +
      task.id +
      "` against a Nap checkout on the host. The agent under measurement is Nap itself, and it",
    "is asked, one turn each:",
    "",
    ...task.prompts.map((prompt) => `- ${prompt}`),
    "",
  ].join("\n");
}

/** One generated file: where it goes under the task directory, and what is in it. */
export type HarborTaskFile = {
  /** Relative to the task's own directory, always with forward slashes. */
  path: string;
  contents: string;
  /** Whether the harness will have to execute it. */
  executable: boolean;
};

/**
 * Every file a generated task directory holds, except the bundled verifier.
 *
 * The bundle is left to the script because producing it is a build rather than a decision —
 * this stays a pure function of the task, which is what lets a test read the whole tree
 * without a filesystem.
 */
export function harborTaskFiles(task: BenchTask): HarborTaskFile[] {
  return [
    { path: "task.toml", contents: harborTaskToml(task), executable: false },
    { path: "instruction.md", contents: harborInstruction(task), executable: false },
    { path: "environment/Dockerfile", contents: HARBOR_DOCKERFILE, executable: false },
    { path: "tests/test.sh", contents: HARBOR_TEST_SCRIPT, executable: true },
  ];
}
