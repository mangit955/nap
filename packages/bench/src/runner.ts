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
 * charge an E2B outage to the model. So a failed turn errors with no score, carrying the kind
 * its reason maps to.
 *
 * This file gathers observations and hands them to the gate ladder; it decides nothing about
 * the outcome itself. Every rule that constrains a verdict lives in `gates.ts`, where each
 * rung is a pure function with a test of its own — because a rule buried in the middle of an
 * `async` function that also creates sandboxes is a rule nobody can check.
 */

import type { Runtime } from "@nap/shared/ports/runtime";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SessionStore } from "@nap/shared/ports/session-store";
import { type CategoryWeights, DEFAULT_CATEGORY_WEIGHTS } from "./category.ts";
import { applyGates, type GateInput } from "./gates.ts";
import { diagnosePreview } from "./preview.ts";
import type { BenchReport, CheckResult } from "./report.ts";
import { scoreRun } from "./score.ts";
import { type BenchTask, type CommandCheck, categoryOf, flagsOf, weightOf } from "./task.ts";

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

  // Everything the ladder is entitled to know, filled in as far as the run got. A stage that
  // never happened leaves its field saying so rather than pretending it went well.
  const checks: CheckResult[] = [];
  const observations: GateInput = {
    turn: outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason },
    workspace: { ok: true },
    preview: null,
    checks,
    score: null,
  };

  const finish = (): BenchReport => {
    const verdict = applyGates(observations);
    // Only a run that still carries a score has categories to explain it. An errored run's
    // check list is whatever it managed before it stopped, which is worth keeping.
    const scored = verdict.score === null ? { categories: [] } : scoreRun(checks, weights);

    return {
      runId,
      taskId: task.id,
      sessionId,
      turnId: outcome.turnId,
      status: verdict.status,
      errorKind: verdict.errorKind,
      gates: verdict.gates,
      scoreCap: verdict.scoreCap,
      score: verdict.score,
      categories: scored.categories,
      weights,
      checks,
    };
  };

  // Running checks against a sandbox the turn never reached would score whatever the
  // template already contained, which is not the agent's work.
  if (!outcome.ok) return finish();

  const session = await sessions.get(sessionId);
  // No such session at all: the run was pointed at something that does not exist, which is
  // whoever composed it rather than anything that happened during it.
  if (session == null) {
    observations.workspace = { ok: false, missing: "session" };
    return finish();
  }
  // A completed turn always leaves a sandbox behind, so this is the workspace having gone
  // away underneath the run rather than anything the agent did.
  if (session.sandboxId == null) {
    observations.workspace = { ok: false, missing: "sandbox" };
    return finish();
  }

  const sandboxId = session.sandboxId;

  if (task.preview !== undefined) {
    observations.preview = await diagnosePreview(
      sandbox,
      sandboxId,
      task.preview.port,
      task.preview.timeoutMs === undefined ? {} : { timeoutMs: task.preview.timeoutMs },
    );

    // Nothing downstream can be measured through a sandbox nobody can reach, and running the
    // checks anyway would record their failures as the agent's.
    if (observations.preview.state === "unreachable") return finish();
  }

  // Every declared check is run and recorded, including when the application did not start:
  // an app that never came up is exactly the run whose checks must not go missing, since a
  // missing check drops its category out of the weighting and *raises* the score.
  for (const check of task.checks) {
    checks.push(await runCommandCheck(sandbox, sandboxId, check));
  }

  observations.score = scoreRun(checks, weights).overall;

  return finish();
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
    ...flagsOf(check),
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
