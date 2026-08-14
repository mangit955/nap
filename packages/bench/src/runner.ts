/**
 * One run: send the task's prompt through Nap, then judge what came out.
 *
 * Written against ports and nothing else — `Runtime`, `SandboxManager`, `SessionStore` — which
 * is what lets the whole composition be driven by a test with no network, no model and no
 * database. It never reimplements the agent loop; running a turn is `Runtime.runTurn`, and
 * this decides only what to ask and what to make of the answer.
 *
 * **The distinction the benchmark rests on**, and the reason this is not simply "score the
 * checks": a turn that failed produced *no observation*. Scoring it zero would be indis-
 * tinguishable from an agent that built something broken, and since the runtime's failure
 * reasons already span both agent causes and infrastructure ones, a zero would silently
 * charge an E2B outage to the model. So a failed turn errors with no score. Which *kind* of
 * error, and the rest of the gate ladder, belong to the ticket that owns them.
 */

import type { Runtime } from "@nap/shared/ports/runtime";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SessionStore } from "@nap/shared/ports/session-store";
import type { BenchReport, CheckResult } from "./report.ts";
import { scoreChecks } from "./score.ts";
import type { BenchTask, CommandCheck } from "./task.ts";

export type BenchRunnerDeps = {
  runtime: Runtime;
  sandbox: SandboxManager;
  sessions: SessionStore;
  /**
   * The session this run drives, already created by whoever composed the run.
   *
   * Isolation between runs is structural — a fresh session, and stores of its own — and that
   * is a property of the composition rather than of the runner, so it is arranged above and
   * simply handed down.
   */
  sessionId: string;
  /** Injectable so a test can assert on a report whole, rather than around a random field. */
  runId?: string;
};

export async function runBenchTask(task: BenchTask, deps: BenchRunnerDeps): Promise<BenchReport> {
  const { runtime, sandbox, sessions, sessionId } = deps;
  const runId = deps.runId ?? crypto.randomUUID();

  const outcome = await runtime.runTurn({ sessionId, message: task.prompt });

  if (!outcome.ok) {
    return {
      runId,
      taskId: task.id,
      sessionId,
      turnId: outcome.turnId,
      status: "errored",
      score: null,
      // Not one check ran, and an empty list says exactly that. Recording them as failed
      // would claim the agent's output was measured and found wanting.
      checks: [],
    };
  }

  const session = await sessions.get(sessionId);
  if (session?.sandboxId == null) {
    // A completed turn always leaves a sandbox behind, so this is the workspace having gone
    // away underneath the run rather than anything the agent did.
    return {
      runId,
      taskId: task.id,
      sessionId,
      turnId: outcome.turnId,
      status: "errored",
      score: null,
      checks: [],
    };
  }

  const checks: CheckResult[] = [];
  for (const check of task.checks) {
    checks.push(await runCommandCheck(sandbox, session.sandboxId, check));
  }

  const score = scoreChecks(checks);
  return {
    runId,
    taskId: task.id,
    sessionId,
    turnId: outcome.turnId,
    status: checks.every((check) => check.passed) ? "passed" : "failed",
    score,
    checks,
  };
}

/**
 * Runs one command in the sandbox and reads its exit code.
 *
 * A sandbox that refuses the command is recorded as a *failed* check rather than omitted.
 * Leaving it out would raise the score of a run that could not be measured, which is the one
 * direction this must never round.
 */
async function runCommandCheck(
  sandbox: SandboxManager,
  sandboxId: string,
  check: CommandCheck,
): Promise<CheckResult> {
  const result = await sandbox.exec(sandboxId, check.command);

  if (!result.ok) {
    return {
      checkId: check.id,
      kind: "command",
      passed: false,
      detail: `could not run: ${result.error.code} — ${result.error.message}`,
    };
  }

  return {
    checkId: check.id,
    kind: "command",
    passed: result.value.exitCode === 0,
    detail: `exit ${result.value.exitCode}`,
  };
}
