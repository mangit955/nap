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

import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { EventStore } from "@nap/shared/ports/event-store";
import type { Runtime } from "@nap/shared/ports/runtime";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SessionRecord, SessionStore } from "@nap/shared/ports/session-store";
import type { Result, VoidResult } from "@nap/shared/result";
import { captureCommandOutput } from "@nap/verify/command-output";
import { diagnosePreview } from "@nap/verify/preview";
import type { AccessibilityCheck } from "./accessibility-check.ts";
import type { BrowserCheck } from "./browser-check.ts";
import { runAccessibilityCheck, runBrowserCheck } from "./browser-executor.ts";
import type { BrowserSession, BrowserSessionFactory } from "./browser-session.ts";
import { type CategoryWeights, DEFAULT_CATEGORY_WEIGHTS } from "./category.ts";
import { applyGates, type BrowserUnavailable, type GateInput } from "./gates.ts";
import { deriveRunMetrics } from "./metrics.ts";
import type { BenchReport, CheckResult } from "./report.ts";
import type { HarnessRecord, TurnBudgetRecord } from "./run-configuration.ts";
import { scoreRun } from "./score.ts";
import {
  type CapturedScreenshot,
  refFromMetadata,
  type ScreenshotRef,
  type ScreenshotStore,
} from "./screenshot.ts";
import {
  type BenchTask,
  type CommandCheck,
  categoryOf,
  flagsOf,
  type SeededFile,
  weightOf,
} from "./task.ts";
import type { BenchTrajectory } from "./trajectory.ts";
import { viewportNameForSize } from "./viewport.ts";
import {
  notRunVisualEvaluation,
  VISUAL_NOT_RUN,
  type VisualEvaluation,
  type VisualEvaluationResult,
  visualScoreOf,
} from "./visual.ts";

export type BenchRunnerDeps = {
  runtime: Runtime;
  sandbox: SandboxManager;
  sessions: SessionStore;
  /**
   * The log the run's trajectory is read back out of.
   *
   * Read rather than written: NapBench adds nothing to the stream and derives every metric
   * from what a turn already recorded, which is what keeps evaluation out of the production
   * event contract entirely. See docs/adr/0003.
   */
  events: EventStore;
  /**
   * Where a browser comes from, when the task's checks need one.
   *
   * A factory rather than a session, because isolation between checks is structural here too:
   * one session per check, closed after it, so nothing a check leaves behind can be what makes
   * the next one pass. Optional, because most tasks never open a browser — and a task that does
   * need one and was given no factory errors as a run configured wrong, rather than recording
   * checks nobody could run as the agent's failures.
   */
  browser?: BrowserSessionFactory;
  /**
   * Where screenshots go. Absent takes none, which is what every test that is not about them
   * does — capture is an artefact of a run rather than part of judging one.
   */
  screenshots?: ScreenshotStore;
  /**
   * Who judges how it looked. Defaults to the one that says nobody did.
   *
   * A default rather than an optional call site, because `not_run` is a real answer that every
   * report has to carry: it is what tells a reader the visual category renormalised out rather
   * than being forgotten, and those put every other category on a different denominator.
   */
  visual?: VisualEvaluation;
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
  /**
   * Which model to run on, and the model the cost estimate is priced against.
   *
   * One value for both on purpose: pricing a run against a model other than the one that ran
   * it is the sort of mistake that produces a plausible number nobody can catch. Absent runs
   * the deployment's default, and leaves the estimate absent — the price table cannot price
   * a model nobody named.
   */
  model?: string | undefined;
  /**
   * The ceilings the turn was given, recorded on the report as what the run was held at.
   *
   * Passed in already **resolved** rather than as the options somebody typed: a run that left
   * `maxSteps` to its default and one that passed the default explicitly were held at the same
   * ceiling, and a comparison that refused those two would be refusing over a difference that
   * does not exist. Whoever composes the run owns the defaults — this package cannot see them,
   * since it may not depend on the agent (docs/adr/0001).
   *
   * Absent leaves the budget unrecorded, which is honest and is what stops a comparison
   * refusing: see `run-configuration.ts`.
   */
  budget?: TurnBudgetRecord | undefined;
  /**
   * Which Nap is being measured, recorded on the report as what produced it.
   *
   * Passed in for the same reason the budget is: this package cannot see a git checkout any
   * more than it can see the agent's defaults, and whoever composed the run is the only thing
   * that knows both the sha it is running at and whether it wired verification up.
   *
   * Absent leaves it unrecorded, which is what a run from outside a checkout honestly is.
   */
  harness?: HarnessRecord | undefined;
  /**
   * The clock, injectable so a screenshot's timestamp is assertable rather than merely a string.
   *
   * The only clock this package reads, and it is read for one field: `capturedAt` is a fact about
   * a run that has to be reproducible in a test, and `new Date()` in the middle of a composition
   * makes the assertion `expect.any(String)` — which is not an assertion.
   */
  now?: () => Date;
};

/**
 * What one run produces: the artefact people read, and the record it was derived from.
 *
 * Two values rather than one object with the events inside the report, because they are
 * written to different files and read by different things — a comparison loads reports and
 * only reaches for a trajectory when the scores agree and the question becomes *how*.
 */
export type BenchRunResult = {
  report: BenchReport;
  trajectory: BenchTrajectory;
};

export async function runBenchTask(
  task: BenchTask,
  deps: BenchRunnerDeps,
): Promise<BenchRunResult> {
  const { runtime, sandbox, sessions, sessionId } = deps;
  const runId = deps.runId ?? crypto.randomUUID();
  const weights = deps.weights ?? DEFAULT_CATEGORY_WEIGHTS;
  const now = deps.now ?? (() => new Date());

  // Everything the ladder is entitled to know, filled in as far as the run got. Each field
  // starts at its optimistic value and is written down as the run discovers otherwise; a stage
  // that never happened leaves the field the *earlier* stage set, which is why the ladder is
  // ordered and why a terminal gate stops it — an unreached stage must never be read.
  const checks: CheckResult[] = [];
  const observations: GateInput = {
    seed: { ok: true },
    turn: { ok: true },
    workspace: { ok: true },
    preview: null,
    browser: { ok: true },
    checks,
    score: null,
  };

  // The turn the verdict is about, which for a sequence is the last one attempted: a run that
  // failed halfway is explained by the prompt it failed on, and one that finished is explained
  // by the prompt that finished it. Null until a turn has actually been started.
  let turnId: string | null = null;

  // What the run photographed, in the order it did. Empty on every path that never opened a
  // browser, which includes every path that ended before the checks ran.
  const screenshots: ScreenshotRef[] = [];
  // Overwritten once, after the checks, if a judge was configured. It stays `not_run` on the
  // paths that end early, which is the truthful answer for a run that produced nothing to judge.
  let visual: VisualEvaluationResult = VISUAL_NOT_RUN;

  const finish = async (): Promise<BenchRunResult> => {
    const verdict = applyGates(observations);
    // Only a run that still carries a score has categories to explain it. An errored run's
    // check list is whatever it managed before it stopped, which is worth keeping.
    const scored =
      verdict.score === null
        ? { categories: [] }
        : scoreRun(checks, weights, visualScoreOf(visual));

    // Read at the end rather than during, so the trajectory covers everything the run
    // produced however far it got — an errored run's stream is the most informative thing
    // about it. `seq` starts at 1, so nothing is skipped by asking for everything after 0.
    const events = await deps.events.readFrom(sessionId, 0);

    return {
      report: {
        runId,
        taskId: task.id,
        sessionId,
        turnId,
        status: verdict.status,
        errorKind: verdict.errorKind,
        gates: verdict.gates,
        scoreCap: verdict.scoreCap,
        score: verdict.score,
        categories: scored.categories,
        weights,
        configuration: {
          model: deps.model ?? null,
          budget: deps.budget ?? null,
          harness: deps.harness ?? null,
        },
        checks,
        metrics: deriveRunMetrics(events, { model: deps.model }),
        screenshots,
        visual,
      },
      trajectory: { runId, taskId: task.id, sessionId, events },
    };
  };

  if (task.environment !== undefined) {
    // Looked up here rather than inside the seeding, so that "there is no such session" has one
    // classification instead of two. It is the same fact the workspace gate reports after the
    // turn — somebody pointed the run at a session that does not exist — and it would be absurd
    // for that to be a configuration error on a task that seeds nothing and an infrastructure
    // one on a task that seeds.
    const session = await sessions.get(sessionId);
    if (session == null) {
      observations.workspace = { ok: false, missing: "session" };
      return finish();
    }

    const seeded = await seedEnvironment(sandbox, sessions, session, task.environment.files);
    if (!seeded.ok) {
      observations.seed = { ok: false, detail: seeded.error };
      // Returned before any prompt is sent. The agent was never shown the starting state the
      // task describes, so asking it anything now would spend money on a turn whose result
      // could not be attributed to it.
      return finish();
    }
  }

  // One turn per prompt, in order, stopping at the first that does not complete. A follow-up is
  // written against what the prompt before it was supposed to produce, so sending it after a
  // failure would measure the agent against a workspace the prompt does not describe — and pay
  // for the turn to do it.
  for (const prompt of task.prompts) {
    // Allocated here because nothing queued this: a benchmark drives the runtime directly, so it
    // stands in for the admission that would otherwise have named the turn.
    const outcome = await runtime.runTurn({
      sessionId,
      turnId: crypto.randomUUID(),
      message: prompt,
      model: deps.model,
    });
    turnId = outcome.turnId;

    if (!outcome.ok) {
      observations.turn = { ok: false, reason: outcome.reason };
      // Running checks against a sandbox the turn never reached would score whatever the
      // template already contained, which is not the agent's work.
      return finish();
    }
  }

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

  // The address browser checks are driven against. Absent whenever nothing is serving, which
  // is the case those checks are recorded as failed for rather than run.
  const previewUrl =
    observations.preview?.state === "serving" ? observations.preview.url : undefined;

  // Every declared check is run and recorded, including when the application did not start:
  // an app that never came up is exactly the run whose checks must not go missing, since a
  // missing check drops its category out of the weighting and *raises* the score.
  for (const check of task.checks) {
    if (check.kind === "command") {
      checks.push(await runCommandCheck(sandbox, sandboxId, check));
      continue;
    }

    // The application never came up. Its browser checks *failed* — they asked and did not get
    // what they wanted — and calling them absent would drop the browser category out of the
    // weighting, which is how failing to start could otherwise raise a run's score. See
    // docs/adr/0002.
    if (previewUrl === undefined) {
      checks.push({
        checkId: check.id,
        // Its own kind, not "browser" for everything that needs one: a report is read without
        // the task beside it, and an audit recorded as a browser check would be uncountable.
        kind: check.kind,
        category: categoryOf(check),
        weight: weightOf(check),
        ...flagsOf(check),
        outcome: "failed",
        detail:
          check.kind === "accessibility"
            ? "the application was not serving, so it could not be audited"
            : "the application was not serving, so it could not be driven",
      });
      continue;
    }

    const attempted = await runBrowserCheckWith(
      deps.browser,
      check,
      previewUrl,
      async (session) => {
        // Photographed *after* the check's last step and before the session closes, which is
        // what makes the image show what the agent's application actually did rather than its
        // starting state. A failure here is swallowed on purpose — see `capture`.
        const ref = await capture(session, deps.screenshots, {
          taskId: task.id,
          runId,
          check,
          now,
        });
        if (ref !== undefined) screenshots.push(ref);
      },
    );
    if (!attempted.ok) {
      // No browser is the evaluator's problem, not the agent's, and it is terminal: every
      // remaining browser check would fail for the same reason, and none of them would be
      // saying anything about the application.
      observations.browser = { ok: false, ...attempted.error };
      return finish();
    }

    checks.push(attempted.value);
  }

  // Asked once, after every check, because a judge is shown the run's whole set of screenshots
  // rather than one at a time — "does this application look coherent" is not a per-check
  // question. Before the gate ladder sees a score, so that the number it judges is the one the
  // report will carry.
  visual = await (deps.visual ?? notRunVisualEvaluation()).evaluate({
    taskId: task.id,
    runId,
    screenshots,
  });

  observations.score = scoreRun(checks, weights, visualScoreOf(visual)).overall;

  return finish();
}

/**
 * Puts the task's declared starting state into the project, before the agent is asked anything.
 *
 * **A sandbox has to exist first, and normally none does.** The runtime creates one on the first
 * turn, which is too late — the whole point of seeding is that the agent sees the files rather
 * than writes them. So this creates one and records it on the session, which is exactly what
 * `acquireSandbox` looks for: the first turn then *resumes* the seeded sandbox instead of opening
 * an empty one. A session that already has a sandbox is seeded in place rather than replaced,
 * because whoever composed the run may have arranged one deliberately.
 *
 * Paths are joined against the project root here, so a task declares `src/App.tsx` and never has
 * to know where in a sandbox a project lives — which is also what makes the schema's
 * "no absolute, no climbing out" rule mean something.
 */
async function seedEnvironment(
  sandbox: SandboxManager,
  sessions: SessionStore,
  session: SessionRecord,
  files: readonly SeededFile[],
): Promise<VoidResult<string>> {
  let sandboxId = session.sandboxId;
  if (sandboxId === null) {
    const created = await sandbox.create(session.projectId);
    if (!created.ok) {
      return { ok: false, error: `could not create a sandbox to seed: ${created.error.message}` };
    }
    sandboxId = created.value.id;
    // Recorded before anything is written, so the first turn resumes this sandbox rather than
    // opening a second one and leaving the seeded files in an orphan nobody looks at.
    await sessions.setSandboxId(session.sessionId, sandboxId);
  }

  for (const file of files) {
    const path = `${PROJECT_ROOT_PATH}/${file.path}`;
    const written = await sandbox.writeFile(sandboxId, path, file.contents);
    if (!written.ok) {
      return { ok: false, error: `could not seed ${file.path}: ${written.error.message}` };
    }
  }

  return { ok: true, value: undefined };
}

/**
 * Photographs the page a check left behind, stores it, and describes where it went.
 *
 * **Every failure here returns undefined rather than propagating**, and that is the point: a
 * screenshot is evidence *about* a run, not an observation *of* the application. A browser that
 * would not photograph, or a disk with no room on it, must leave the run's score untouched —
 * the alternative is a full disk being recorded as an agent that wrote a broken application,
 * on a run that has already been paid for.
 */
async function capture(
  session: BrowserSession,
  store: ScreenshotStore | undefined,
  run: {
    taskId: string;
    runId: string;
    /** Only the two fields a capture records — which is why an audit can be photographed too. */
    check: { id: string; referenceScreenshot?: string | undefined };
    now: () => Date;
  },
): Promise<ScreenshotRef | undefined> {
  if (store === undefined) return undefined;

  const shot = await session.screenshot();
  if (!shot.ok) return undefined;

  const captured: CapturedScreenshot = {
    metadata: {
      taskId: run.taskId,
      runId: run.runId,
      checkId: run.check.id,
      viewport: {
        // The measured size decides the name, and nothing else does. A check may resize partway
        // through, so its declaration is not evidence about the page that was photographed — and
        // falling back to it for an unrecognised size would produce exactly the mislabelled
        // capture `viewportNameForSize` returns undefined to avoid. Null is the honest answer.
        name: viewportNameForSize(shot.value.viewport) ?? null,
        ...shot.value.viewport,
      },
      capturedAt: run.now().toISOString(),
      reference: run.check.referenceScreenshot ?? null,
    },
    bytes: shot.value.bytes,
  };

  const stored = await store(captured);
  return stored.ok ? refFromMetadata(captured.metadata, stored.value) : undefined;
}

/**
 * Drives one browser check in a session of its own, and closes it afterwards.
 *
 * The session is closed on every path, including the one where the check failed: a browser
 * left open holds a process, and a suite is dozens of checks long. Failing to *obtain* a
 * session and failing to *drive* one are both returned rather than thrown, because the gate
 * ladder is the only thing entitled to decide what a run without a browser means.
 */
async function runBrowserCheckWith(
  factory: BrowserSessionFactory | undefined,
  check: BrowserCheck | AccessibilityCheck,
  baseUrl: string,
  /**
   * Run against the live session after the check and before it closes — the only window in
   * which the page the check left behind still exists.
   */
  afterCheck: (session: BrowserSession) => Promise<void>,
): Promise<Result<CheckResult, BrowserUnavailable>> {
  if (factory === undefined) {
    return {
      ok: false,
      error: {
        reason: "not_configured",
        detail:
          `the task declares ${check.kind} check "${check.id}" ` +
          "and the run was given no browser",
      },
    };
  }

  const opened = await factory();
  if (!opened.ok) {
    return { ok: false, error: { reason: "unavailable", detail: opened.error.message } };
  }

  try {
    // The two kinds that need a browser, each driven by its own executor. Dispatched here
    // rather than inside one executor with a branch, because what they do once the page is
    // open has nothing in common: one runs a sequence of steps, the other runs an audit.
    const result =
      check.kind === "accessibility"
        ? await runAccessibilityCheck(opened.value, check, { baseUrl })
        : await runBrowserCheck(opened.value, check, { baseUrl });
    // Photographed whatever the check concluded: a *failed* check is the one whose picture is
    // most worth having, since it is the one somebody will want to look at.
    await afterCheck(opened.value);
    if (result.ok) return result;

    return { ok: false, error: { reason: "unavailable", detail: result.error.message } };
  } finally {
    await opened.value.close();
  }
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

  const passed = result.value.exitCode === 0;

  return {
    ...declared,
    outcome: passed ? "passed" : "failed",
    detail: `exit ${result.value.exitCode}`,
    // Only on a failure, and only when there was something to keep. A passing build's output
    // is hundreds of lines nobody reads, landing in an artefact that people diff — churn that
    // moves run to run for reasons unrelated to any score.
    ...(passed ? {} : { output: captureCommandOutput(result.value) }),
  };
}
