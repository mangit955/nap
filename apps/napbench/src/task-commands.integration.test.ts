/**
 * Every command the benchmark's tasks run, executed against a **pristine** template.
 *
 * This exists because of a bug that shipped. Every task's `code` check ran `bun run lint`, the
 * template has no `lint` script, and so the check returned `exit 1: Script not found` on every
 * run of every task for every model — a whole scoring category that could not be earned. The
 * first funded run is what found it, four sandboxes and five turns later, and the write-up is in
 * `docs/napbench-first-real-run.md`.
 *
 * **No fake could have caught it, and that is the point.** The in-memory sandbox answers an
 * unscripted command with a plausible success, so the dead check passed in every dry run; the
 * unit tests assert what a task *declares*, which was correct. The only thing that can tell
 * whether a command exists inside the image is the image.
 *
 * The assertion is deliberately narrow: these commands must succeed on a project **nobody has
 * touched yet**. A benchmark check has to be able to fail on the agent's work — but one that
 * cannot pass on the starting state is measuring the harness, not the agent, and it penalises
 * every model equally and invisibly. Build and typecheck are the two that hold on an untouched
 * template; browser checks are not, since the template renders no application of its own.
 *
 * **Needs: `E2B_API_KEY`, and the network.** It creates one real sandbox and destroys it, which
 * costs seconds of sandbox time and no model calls. Credentials come from `apps/api/.env` via
 * the integration setup.
 */

import { BENCH_TASKS } from "@nap/bench/suite";
import { E2BSandboxManager } from "@nap/sandbox/e2b-sandbox-manager";
import { NAP_TEMPLATE } from "@nap/sandbox/template";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

if (process.env.E2B_API_KEY === undefined || process.env.E2B_API_KEY === "") {
  throw new Error(
    "E2B_API_KEY is not set, so the task commands cannot be checked against a real template. " +
      "Put it in apps/api/.env or export it, then re-run `bun run test:integration`.",
  );
}

const sandbox = new E2BSandboxManager({ template: NAP_TEMPLATE });
let sandboxId: string;

beforeAll(async () => {
  const created = await sandbox.create(crypto.randomUUID());
  if (!created.ok) throw new Error(`could not create a sandbox: ${created.error.message}`);
  sandboxId = created.value.id;
}, 120_000);

afterAll(async () => {
  // Billed by the second, and one left running outlives the suite that made it.
  if (sandboxId !== undefined) await sandbox.destroy(sandboxId);
});

/** Every command check a task declares, with the task it came from, as one flat list. */
function commandChecks(): { taskId: string; checkId: string; command: string }[] {
  return BENCH_TASKS.flatMap((task) =>
    task.checks
      .filter((check) => check.kind === "command")
      .map((check) => ({ taskId: task.id, checkId: check.id, command: check.command })),
  );
}

describe("the commands the benchmark's tasks run", () => {
  it.each(commandChecks().map((entry) => [`${entry.taskId} / ${entry.checkId}`, entry] as const))(
    "%s succeeds on a template nobody has touched",
    async (_name, entry) => {
      const result = await sandbox.exec(sandboxId, entry.command);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The output is in the message on purpose: `exit 1` alone is what made the original bug
      // survive a funded run, since the report records the code and not the reason.
      expect(
        result.value.exitCode,
        `${entry.command}\n${result.value.stdout}${result.value.stderr ?? ""}`,
      ).toBe(0);
    },
    120_000,
  );
});
