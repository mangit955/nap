import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { APP_TEST_TASKS, parseAppTestArgs } from "@nap/bench/app-test";

try {
  const options = parseAppTestArgs(process.argv.slice(2));
  if (options.real)
    throw new Error(
      "Real app-test evaluation is pending paid approval and an approved desktop template/composition. See docs/NAPBENCH.md, Planted-bug app tests.",
    );
  // Import only after refusing real intent and invalid flags. The free path reads no credentials.
  const { runScriptedAppTest } = await import("./app-test-harness.ts");
  const tasks = APP_TEST_TASKS.filter(
    (task) => options.taskId === null || task.id === options.taskId,
  );
  const runs = [];
  for (const task of tasks) runs.push(await runScriptedAppTest(task));
  const measured = runs.filter((run) => run.assessment.status === "measured");
  const bugs = measured.filter((run) => run.task.expected === "failed");
  const correct = measured.filter((run) => run.task.expected === "passed");
  const report = {
    mode: "scripted",
    modelCapability: null,
    realEvaluation: "pending",
    apparatus: {
      bugsCaught: bugs.filter((run) => run.assessment.score === 1).length,
      bugsTested: bugs.length,
      correctAccepted: correct.filter((run) => run.assessment.score === 1).length,
      correctTested: correct.length,
      unmeasured: runs.length - measured.length,
    },
    runs,
  };
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Scripted apparatus only; no model capability measured. ${JSON.stringify(report.apparatus)}\n${options.out}`,
  );
  process.exitCode = report.apparatus.unmeasured === 0 ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
