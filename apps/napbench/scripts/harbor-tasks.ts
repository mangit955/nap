/**
 * Regenerates the Harbor task registry from the benchmark's own list of tasks.
 *
 * `bun run harbor:tasks`
 *
 * One directory per task under `harbor/tasks/`, each holding an instruction, a container
 * definition, a verifier script and the bundled trial entrypoint the verifier runs. Generated
 * rather than committed, for the reason `napbench-results/` is not committed: it is derived
 * from something already in the tree, and a stale copy of it would answer questions about the
 * benchmark wrongly. `@nap/bench/suite` is the registry; this is a projection of it.
 *
 * The bundle is the only interesting part. It is `napbench-trial.ts` compiled to a single
 * file, so the generated container needs a Bun runtime and nothing else — no checkout, no
 * install, no network. That is what keeps the reward rule in `packages/bench/src/reward.ts`
 * and out of the harness while still having a verifier that can execute it.
 */

import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BENCH_TASKS } from "@nap/bench/suite";
import { HARBOR_TASKS_DIR, HARBOR_VERIFIER_FILE, harborTaskFiles } from "../src/harbor-task.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const TASKS_ROOT = join(REPO_ROOT, HARBOR_TASKS_DIR);
const TRIAL_ENTRYPOINT = join(import.meta.dirname, "napbench-trial.ts");
/** Built once, then copied into each task: nine identical bundles, one compile. */
const BUNDLE = join(TASKS_ROOT, ".verifier.js");

// Regenerated wholesale rather than merged into: a task removed from the suite has to
// disappear from the registry, and a directory nobody deleted is a task the harness would
// happily still run.
await rm(TASKS_ROOT, { recursive: true, force: true });
await mkdir(TASKS_ROOT, { recursive: true });

// The bundler is invoked as a command rather than through `Bun.build`, because nothing else in
// this repository names a Bun global and typing one would mean adding `@types/bun` to a
// workspace that runs its tests under Node.
const built = spawnSync("bun", ["build", TRIAL_ENTRYPOINT, "--target=bun", `--outfile=${BUNDLE}`], {
  cwd: REPO_ROOT,
  encoding: "utf8",
});
if (built.status !== 0) {
  console.error(
    `the verifier could not be bundled:\n${built.stderr ?? built.error?.message ?? ""}`,
  );
  process.exit(1);
}

const verifier = await readFile(BUNDLE, "utf8");
await rm(BUNDLE);

for (const task of BENCH_TASKS) {
  const taskDir = join(TASKS_ROOT, task.id);

  for (const file of harborTaskFiles(task)) {
    const path = join(taskDir, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.contents, "utf8");
    // The harness executes `tests/test.sh` directly, and a file it cannot execute fails the
    // trial after the money has been spent rather than before.
    if (file.executable) await chmod(path, 0o755);
  }

  await writeFile(join(taskDir, "tests", HARBOR_VERIFIER_FILE), verifier, "utf8");
}

console.log(
  `${BENCH_TASKS.length} task(s) written to ${TASKS_ROOT}\n` +
    "Each is self-contained: the verifier is bundled into it, so the generated container needs " +
    "only Bun.",
);
