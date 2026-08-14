/**
 * The smallest task that is still a real one: one prompt, one command check.
 *
 * It exists to prove the spine end to end — a task goes in, a scored report comes out — and
 * it is deliberately not a good benchmark task. It asks for something almost any model will
 * manage and checks only that the project still builds afterwards, because what is being
 * measured here is the harness rather than the agent. The tasks that measure the agent are a
 * separate piece of work.
 *
 * The shape is the contract, though: this is what every later task file looks like.
 */

import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { defineTask } from "../task.ts";

export const TRACER_TASK = defineTask({
  id: "tracer",
  name: "Change the heading",
  prompt: "Change the main heading on the page to say 'Hello from NapBench'.",
  checks: [
    {
      id: "build",
      kind: "command",
      // `cd` into the project because a check runs wherever the sandbox drops it, and the
      // project is a subdirectory of the home directory rather than the home directory.
      // The path comes from the shared constant that already has to agree with the template
      // and the system prompt, rather than being a fourth copy of the same string.
      command: `cd ${PROJECT_ROOT_PATH} && bun run build`,
    },
  ],
});
