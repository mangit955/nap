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
 * error it was, and the rest of the gate ladder CONTEXT.md describes, do not exist yet.
 */

import type { Runtime } from "@nap/shared/ports/runtime";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SessionStore } from "@nap/shared/ports/session-store";
import { type CategoryWeights, DEFAULT_CATEGORY_WEIGHTS } from "./category.ts";
import type { BenchReport, CheckResult } from "./report.ts";
import { scoreRun } from "./score.ts";
import { type BenchTask, type CommandCheck, categoryOf, weightOf } from "./task.ts";

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
  /**
   * What each category is worth. Defaults to 50/25/15/10.
   *
   * Configurable so the benchmark's priorities can change without rewriting a single task —
   * and recorded in every report, because the vector is what a score means.
   */
  weights?: CategoryWeights;
};

export async function runBenchTask(task: BenchTask, deps: BenchRunnerDeps): Promise<BenchReport> {
  const { runtime, sandbox, sessions, sessionId } = deps;
  const runId = deps.runId ?? crypto.randomUUID();
  const weights = deps.weights ?? DEFAULT_CATEGORY_WEIGHTS;

  const outcome = await runtime.runTurn({ sessionId, message: task.prompt });

  // No check ran, and an empty list says exactly that. Recording them as failed would claim
  // the agent's output was measured and found wanting, which is the confusion this whole
  // status exists to prevent.
  const errored = (): BenchReport => ({
    runId,
    taskId: task.id,
    sessionId,
    turnId: outcome.turnId,
    status: "errored",
    score: null,
    categories: [],
    weights,
    checks: [],
  });

  if (!outcome.ok) return errored();

  const session = await sessions.get(sessionId);
  // A completed turn always leaves a sandbox behind, so this is the workspace having gone
  // away underneath the run rather than anything the agent did.
  if (session?.sandboxId == null) return errored();

  const checks: CheckResult[] = [];
  for (const check of task.checks) {
    checks.push(await runCommandCheck(sandbox, session.sandboxId, check));
  }

  const scored = scoreRun(checks, weights);

  // Nothing produced a result, so there is nothing to score and nothing to call a pass. A
  // completed turn whose every check was unaskable is an absence of observation, which is
  // the same finding as a turn that never ran — not a run that scored zero.
  if (scored.overall === null) return errored();

  return {
    runId,
    taskId: task.id,
    sessionId,
    turnId: outcome.turnId,
    // Every check that produced a result had to pass. An absent one is not a failure — the
    // gate ladder decides what an unaskable check means for a run.
    status: checks.every((check) => check.outcome !== "failed") ? "passed" : "failed",
    score: scored.overall,
    categories: scored.categories,
    weights,
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

  const declared = {
    checkId: check.id,
    kind: "command",
    category: categoryOf(check),
    weight: weightOf(check),
    required: check.required ?? false,
  } as const;

  if (!result.ok) {
    return {
      ...declared,
      // Failed rather than absent: the task asked for this and did not get it. Absent would
      // drop the whole category out of the weighting, which is how failing to run a check
      // could otherwise *raise* a run's score.
      outcome: "failed",
      detail: `could not run: ${result.error.code} — ${result.error.message}`,
    };
  }

  return {
    ...declared,
    outcome: result.value.exitCode === 0 ? "passed" : "failed",
    detail: `exit ${result.value.exitCode}`,
  };
}
