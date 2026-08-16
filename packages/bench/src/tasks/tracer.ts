/**
 * The smallest task that is still a real one: one prompt, one command check.
 *
 * It exists to prove the spine end to end — a task goes in, a scored report comes out — and
 * it is deliberately not a good benchmark task. It asks for something almost any model will
 * manage and checks only that the project still builds afterwards, because what is being
 * measured here is the harness rather than the agent. The tasks that measure the agent sit
 * beside it in this directory and assert a great deal more.
 *
 * It stays because "is the machinery joined up?" is a question worth being able to ask for
 * nothing, and it is named as the `smoke` suite so that asking it is a command rather than a
 * piece of folklore. It belongs to no suite that characterises a model: a task that asserts
 * almost nothing would flatter whatever was averaged in beside it.
 */

import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { defineTask } from "../task.ts";

export const TRACER_TASK = defineTask({
  id: "tracer",
  name: "Change the heading",
  prompts: ["Change the main heading on the page to say 'Hello from NapBench'."],
  checks: [
    {
      id: "build",
      kind: "command",
      // `cd` into the project because a check runs wherever the sandbox drops it, and the
      // project is a subdirectory of the home directory rather than the home directory.
      // The path comes from the shared constant that already has to agree with the template
      // and the system prompt, rather than being a fourth copy of the same string.
      command: `cd ${PROJECT_ROOT_PATH} && bun run build`,
      // The gate, not just a check: a project that does not compile cannot be most of the
      // way to good, so this failing caps the run as well as failing it.
      build: true,
    },
    {
      id: "typecheck",
      kind: "command",
      // The override, and the reason it has to exist: this is the same *kind* of check as the
      // build above and belongs on a different axis. A project that does not typecheck is worse
      // written; a project that does not build does not work, and the two must not average.
      //
      // `bunx tsc --noEmit` rather than a script in the template, because the template has no
      // lint or typecheck script — the first funded run discovered that the hard way. See
      // docs/napbench-first-real-run.md.
      category: "code",
      command: `cd ${PROJECT_ROOT_PATH} && bunx tsc --noEmit`,
    },
  ],
});
