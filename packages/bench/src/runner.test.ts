/**
 * The runner, against ports alone — the in-memory sandbox and a scripted Runtime.
 *
 * No network, no model, no Postgres: the whole point of putting the runner in the pure
 * package is that the composition it performs can be driven from a test this cheap.
 */

import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { Runtime, TurnOutcome } from "@nap/shared/ports/runtime";
import { describe, expect, it } from "vitest";
import type { BrowserStep } from "./browser-check.ts";
import { DEFAULT_CATEGORY_WEIGHTS } from "./category.ts";
import { BUILD_FAILURE_SCORE_CAP } from "./gates.ts";
import { runBenchTask } from "./runner.ts";
import { scoreRun } from "./score.ts";
import { type CapturedScreenshot, type ScreenshotStore, screenshotFilename } from "./screenshot.ts";
import { parseBenchTask } from "./task.ts";
import {
  ScriptedBrowserSession,
  type ScriptedBrowserSessionOptions,
} from "./testing/scripted-browser-session.ts";
import { manualVisualEvaluation, VISUAL_NOT_RUN, type VisualEvaluationInput } from "./visual.ts";

const SESSION_ID = "3f2a1c4e-0000-4000-8000-000000000002";
const TURN_ID = "3f2a1c4e-0000-4000-8000-000000000003";
const RUN_ID = "3f2a1c4e-0000-4000-8000-000000000001";
const NOW = "2026-08-14T00:00:00.000Z";
// The in-memory sandbox only answers for sandboxes it created itself, so every test that
// wants a check to run has to create one and seed the session with *that* id.

function task(
  checks: {
    id: string;
    command: string;
    category?: "functional" | "browser" | "visual" | "code";
    required?: boolean;
    build?: boolean;
    weight?: number;
  }[] = [{ id: "build", command: "bun run build" }],
  extras: { preview?: { port: number } } = {},
) {
  const parsed = parseBenchTask({
    id: "landing-page",
    name: "A landing page",
    prompts: ["Build a landing page."],
    ...extras,
    checks: checks.map((check) => ({ ...check, kind: "command" })),
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** A Runtime that records what it was asked and answers with whatever it was given. */
function scriptedRuntime(outcome: TurnOutcome): Runtime & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    async runTurn(request) {
      messages.push(request.message);
      return outcome;
    },
    async resumeSession() {
      throw new Error("the runner must not resume a session — every run is a fresh one");
    },
  };
}

async function deps(runtime: Runtime, sandbox: InMemorySandboxManager) {
  const created = await sandbox.create(crypto.randomUUID());
  if (!created.ok) throw new Error("the fake refused to create a sandbox");

  return {
    runtime,
    sandbox,
    sessions: new InMemorySessionStore([
      { sessionId: SESSION_ID, projectId: crypto.randomUUID(), sandboxId: created.value.id },
    ]),
    events: new InMemoryEventStore(),
    sessionId: SESSION_ID,
    runId: RUN_ID,
    sandboxId: created.value.id,
  };
}

/**
 * The report half of a run.
 *
 * Most of these tests are about what a run concluded rather than what it recorded, and the
 * scripted Runtime writes no events at all — the trajectory has its own cases at the end.
 */
async function reportOf(...args: Parameters<typeof runBenchTask>) {
  return (await runBenchTask(...args)).report;
}

const completed: TurnOutcome = { ok: true, turnId: TURN_ID, commitSha: "a".repeat(40) };

describe("runBenchTask", () => {
  it("sends the task's prompt through the Runtime", async () => {
    const runtime = scriptedRuntime(completed);
    const sandbox = new InMemorySandboxManager({
      defaultExec: () => ({ exitCode: 0, stdout: "" }),
    });

    await reportOf(task(), await deps(runtime, sandbox));

    expect(runtime.messages).toEqual(["Build a landing page."]);
  });

  it("passes a run whose command check exits zero", async () => {
    const sandbox = new InMemorySandboxManager().script(/bun run build/, {
      exitCode: 0,
      stdout: "built",
    });

    const report = await reportOf(task(), await deps(scriptedRuntime(completed), sandbox));

    expect(report.status).toBe("passed");
    expect(report.score).toBe(100);
    expect(report.checks).toEqual([
      {
        checkId: "build",
        kind: "command",
        category: "functional",
        weight: 1,
        required: false,
        build: false,
        outcome: "passed",
        detail: "exit 0",
      },
    ]);
  });

  it("fails a run whose command check exits non-zero", async () => {
    const sandbox = new InMemorySandboxManager().script(/bun run build/, {
      exitCode: 1,
      stderr: "type error",
    });

    const report = await reportOf(task(), await deps(scriptedRuntime(completed), sandbox));

    expect(report.status).toBe("failed");
    expect(report.score).toBe(0);
    expect(report.checks[0]?.outcome).toBe("failed");
  });

  it("runs every check, not just up to the first failure", async () => {
    // A report that stopped at the first failure would say nothing about the rest, and
    // the score would depend on the order the checks happen to be declared in.
    const sandbox = new InMemorySandboxManager()
      .script(/build/, { exitCode: 1 })
      .script(/lint/, { exitCode: 0 });

    const report = await reportOf(
      task([
        { id: "build", command: "bun run build" },
        { id: "lint", command: "bun run lint" },
      ]),
      await deps(scriptedRuntime(completed), sandbox),
    );

    expect(report.checks.map((check) => check.checkId)).toEqual(["build", "lint"]);
    expect(report.score).toBe(50);
  });

  it("scores under the weights it was given and records them", async () => {
    // The runner's own wiring of a configured vector, as distinct from scoreRun's.
    const sandbox = new InMemorySandboxManager()
      .script(/build/, { exitCode: 0 })
      .script(/lint/, { exitCode: 1 });

    const weights = { functional: 10, browser: 25, visual: 15, code: 90 } as const;
    const report = await reportOf(
      task([
        { id: "build", command: "bun run build" },
        { id: "lint", command: "bun run lint", category: "code" },
      ]),
      { ...(await deps(scriptedRuntime(completed), sandbox)), weights },
    );

    // Code was made to matter nine times more than functional, and the failing lint check
    // sinks the run accordingly: 100 * (10/100) = 10.
    expect(report.weights).toEqual(weights);
    expect(report.score).toBe(10);
  });

  it("errors when a completed turn left nothing that could be scored", async () => {
    // Distinct from the checks failing: nothing was measured at all, so "passed with zero"
    // would be a result claiming an observation that never happened.
    const sandbox = new InMemorySandboxManager({
      defaultExec: () => ({ exitCode: 0, stdout: "" }),
    });
    const withSandbox = await deps(scriptedRuntime(completed), sandbox);

    const report = await reportOf({ ...task(), checks: [] }, withSandbox);

    expect(report.status).toBe("errored");
    expect(report.score).toBeNull();
  });

  it("records the run, session and turn ids as three separate things", async () => {
    const sandbox = new InMemorySandboxManager({
      defaultExec: () => ({ exitCode: 0, stdout: "" }),
    });

    const report = await reportOf(task(), await deps(scriptedRuntime(completed), sandbox));

    expect(report.runId).toBe(RUN_ID);
    expect(report.sessionId).toBe(SESSION_ID);
    expect(report.turnId).toBe(TURN_ID);
    expect(report.taskId).toBe("landing-page");
  });

  it("errors rather than scoring zero when the turn itself failed", async () => {
    // The distinction the whole benchmark rests on: an agent that produced a broken app
    // scores badly, and an agent that never ran produced no observation at all. Collapsing
    // the second into a zero would quietly blame the model for an outage.
    const runtime = scriptedRuntime({
      ok: false,
      turnId: TURN_ID,
      reason: "sandbox_unavailable",
      message: "no sandbox",
    });
    const sandbox = new InMemorySandboxManager({
      defaultExec: () => ({ exitCode: 0, stdout: "" }),
    });

    const report = await reportOf(task(), await deps(runtime, sandbox));

    expect(report.status).toBe("errored");
    expect(report.score).toBeNull();
    expect(report.checks).toEqual([]);
    // And it says whose fault: a sandbox that would not start is the execution plane's, and
    // an aggregate that could not tell it from a refusal would rank models by their luck.
    expect(report.errorKind).toBe("sandbox");
    expect(report.gates).toEqual(["turn_failed"]);
  });

  it("attributes a provider outage to the model rather than to the agent", async () => {
    const runtime = scriptedRuntime({
      ok: false,
      turnId: TURN_ID,
      reason: "model_unavailable",
      message: "upstream is overloaded",
    });
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });

    const report = await reportOf(task(), await deps(runtime, sandbox));

    expect(report.errorKind).toBe("model");
  });

  it("records a cancelled turn as a cancelled run, which is not an error", async () => {
    const runtime = scriptedRuntime({
      ok: false,
      turnId: TURN_ID,
      reason: "cancelled",
      message: "stopped",
    });
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });

    const report = await reportOf(task(), await deps(runtime, sandbox));

    expect(report.status).toBe("cancelled");
    expect(report.score).toBeNull();
    expect(report.errorKind).toBeNull();
  });

  it("does not execute a single check once the turn has failed", async () => {
    // Running checks against a sandbox the turn never got to would score whatever the
    // template already contained, which is not the agent's work.
    let execs = 0;
    const sandbox = new InMemorySandboxManager({
      defaultExec: () => {
        execs++;
        return { exitCode: 0, stdout: "" };
      },
    });

    await reportOf(
      task(),
      await deps(
        scriptedRuntime({ ok: false, turnId: TURN_ID, reason: "internal", message: "boom" }),
        sandbox,
      ),
    );

    expect(execs).toBe(0);
  });

  it("errors when the session has no sandbox to run checks in", async () => {
    const sandbox = new InMemorySandboxManager({
      defaultExec: () => ({ exitCode: 0, stdout: "" }),
    });
    const withoutSandbox = {
      ...(await deps(scriptedRuntime(completed), sandbox)),
      sessions: new InMemorySessionStore([
        { sessionId: SESSION_ID, projectId: crypto.randomUUID(), sandboxId: null },
      ]),
    };

    const report = await reportOf(task(), withoutSandbox);

    expect(report.status).toBe("errored");
    expect(report.score).toBeNull();
    expect(report.errorKind).toBe("sandbox");
  });

  it("blames configuration, not the plane, when the session does not exist", async () => {
    // A run pointed at a session nobody created is a mistake in how the run was set up, and
    // it must not land in the same bucket as a sandbox that failed to start — one of those
    // is somebody's typo and the other is a provider having a bad afternoon.
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
    const withoutSession = {
      ...(await deps(scriptedRuntime(completed), sandbox)),
      sessions: new InMemorySessionStore([]),
    };

    const report = await reportOf(task(), withoutSession);

    expect(report.status).toBe("errored");
    expect(report.errorKind).toBe("configuration");
    expect(report.gates).toEqual(["workspace_missing"]);
  });

  it("records a check the sandbox refused to run as failed, not as absent", async () => {
    // Dropping the check would raise the score of a run that could not be measured. The
    // ladder deliberately does not promote this to an infrastructure error: telling "the
    // sandbox refused" apart from "the command failed" at the gate would mean changing what
    // a check result records, which is a change to the check contract rather than a rung.
    const sandbox = new InMemorySandboxManager({
      defaultExec: () => ({ exitCode: 0, stdout: "" }),
    });
    const withSandbox = await deps(scriptedRuntime(completed), sandbox);
    await sandbox.destroy(withSandbox.sandboxId);

    const report = await reportOf(task(), withSandbox);

    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]?.outcome).toBe("failed");
    expect(report.status).toBe("failed");
  });
});

describe("runBenchTask — the trajectory it kept", () => {
  /** A Runtime that writes a plausible turn into the log, as the real one does. */
  function loggingRuntime(events: InMemoryEventStore, outcome: TurnOutcome): Runtime {
    return {
      async runTurn() {
        const envelope = { sessionId: SESSION_ID, turnId: TURN_ID, createdAt: NOW };
        await events.append({ ...envelope, type: "turn.started", payload: { source: "user" } });
        await events.append({
          ...envelope,
          type: "tool.call",
          payload: { toolCallId: "call_1", toolName: "write_file", input: {} },
        });
        await events.append({
          ...envelope,
          type: "file.changed",
          payload: { path: "/home/user/app/src/App.tsx", changeType: "modified", diff: "" },
        });
        if (outcome.ok) {
          await events.append({
            ...envelope,
            type: "turn.completed",
            payload: {
              usage: { inputTokens: 1_000, outputTokens: 200 },
              durationMs: 4_000,
              commitSha: "a".repeat(40),
            },
          });
        } else {
          await events.append({
            ...envelope,
            type: "turn.failed",
            payload: { reason: outcome.reason, message: outcome.message },
          });
        }
        return outcome;
      },
      async resumeSession() {
        throw new Error("the runner must not resume a session");
      },
    };
  }

  async function runLogged(outcome: TurnOutcome, model?: string) {
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
    const withSandbox = await deps(scriptedRuntime(completed), sandbox);
    const events = withSandbox.events;

    return runBenchTask(task(), {
      ...withSandbox,
      runtime: loggingRuntime(events, outcome),
      ...(model === undefined ? {} : { model }),
    });
  }

  it("derives the report's metrics from the events the turn recorded", async () => {
    const { report } = await runLogged(completed);

    expect(report.metrics.toolCalls).toBe(1);
    expect(report.metrics.filesChanged).toBe(1);
    expect(report.metrics.turns).toEqual({ started: 1, completed: 1, failed: 0, cancelled: 0 });
    expect(report.metrics.tokens).toEqual({ inputTokens: 1_000, outputTokens: 200 });
  });

  it("keeps the whole stream beside the report, tied to it by the same ids", async () => {
    const { report, trajectory } = await runLogged(completed);

    expect(trajectory.runId).toBe(report.runId);
    expect(trajectory.taskId).toBe(report.taskId);
    expect(trajectory.sessionId).toBe(report.sessionId);
    expect(trajectory.events.map((event) => event.type)).toEqual([
      "turn.started",
      "tool.call",
      "file.changed",
      "turn.completed",
    ]);
  });

  it("keeps the trajectory of a run that errored, which is when it matters most", async () => {
    const { report, trajectory } = await runLogged({
      ok: false,
      turnId: TURN_ID,
      reason: "budget_exceeded",
      message: "out of steps",
    });

    expect(report.status).toBe("errored");
    expect(trajectory.events).toHaveLength(4);
    // What it did before it stopped is still counted; what the log cannot supply is not.
    expect(report.metrics.toolCalls).toBe(1);
    expect(report.metrics.turns.failed).toBe(1);
    expect("tokens" in report.metrics).toBe(false);
    expect("estimatedCost" in report.metrics).toBe(false);
  });

  it("prices the run against the model it was told to run", async () => {
    const { report } = await runLogged(completed, "openai/gpt-5.6-luna");

    expect(report.metrics.estimatedCost?.model).toBe("openai/gpt-5.6-luna");
    expect(report.metrics.estimatedCost?.usd).toBeGreaterThan(0);
  });

  it("leaves cost absent when the run named no model", async () => {
    // The deployment's default ran it, and NapBench does not know what that was. A price
    // for a model nobody named is a number about nothing.
    const { report } = await runLogged(completed);

    expect("estimatedCost" in report.metrics).toBe(false);
  });

  it("asks the Runtime to use the model it was given", async () => {
    const runtime = scriptedRuntime(completed);
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
    const models: (string | undefined)[] = [];
    const recording: Runtime = {
      async runTurn(request) {
        models.push(request.model);
        return runtime.runTurn(request);
      },
      resumeSession: runtime.resumeSession,
    };

    await runBenchTask(task(), {
      ...(await deps(recording, sandbox)),
      model: "anthropic/claude-opus-5",
    });

    // The same value prices the run and runs it, so a report cannot price one model's
    // tokens at another's rate.
    expect(models).toEqual(["anthropic/claude-opus-5"]);
  });

  it("records what the run was held at, so a later comparison can refuse an unfair one", async () => {
    const runtime = scriptedRuntime(completed);
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });

    const report = await reportOf(task(), {
      ...(await deps(runtime, sandbox)),
      model: "anthropic/claude-opus-5",
      budget: { maxSteps: 8, maxTokens: 40_000 },
    });

    expect(report.configuration).toEqual({
      model: "anthropic/claude-opus-5",
      budget: { maxSteps: 8, maxTokens: 40_000 },
    });
  });

  it("keeps what a failed command said, which is the part `exit 1` leaves out", async () => {
    // The case this exists for, taken from a real funded run: the report said `exit 1` and the
    // sentence explaining it was on a stderr nobody kept, so diagnosing it meant paying twice.
    const runtime = scriptedRuntime(completed);
    const sandbox = new InMemorySandboxManager({
      defaultExec: () => ({ exitCode: 1, stdout: "", stderr: 'Script not found "lint"' }),
    });

    const report = await reportOf(task(), await deps(runtime, sandbox));

    expect(report.checks[0]?.output?.stderr.text).toBe('Script not found "lint"');
    expect(report.checks[0]?.output?.stderr.truncated).toBe(false);
  });

  it("keeps nothing from a command that passed", async () => {
    // A green build's output is hundreds of lines nobody reads, in an artefact people diff.
    const runtime = scriptedRuntime(completed);
    const sandbox = new InMemorySandboxManager({
      defaultExec: () => ({ exitCode: 0, stdout: "built in 1.2s", stderr: "" }),
    });

    const report = await reportOf(task(), await deps(runtime, sandbox));

    expect(report.checks[0]?.outcome).toBe("passed");
    expect(report.checks[0]?.output).toBeUndefined();
  });

  it("truncates a torrent to the tail, and says that it did", async () => {
    const runtime = scriptedRuntime(completed);
    const sandbox = new InMemorySandboxManager({
      defaultExec: () => ({
        exitCode: 1,
        stdout: `${"noise".repeat(4_000)}THE ACTUAL ERROR`,
        stderr: "",
      }),
    });

    const report = await reportOf(task(), await deps(runtime, sandbox));

    expect(report.checks[0]?.output?.stdout.truncated).toBe(true);
    expect(report.checks[0]?.output?.stdout.text.endsWith("THE ACTUAL ERROR")).toBe(true);
  });

  it("records nothing rather than guessing when the run was composed without either", async () => {
    // A plausible default written here would be a ceiling the run was never actually held at,
    // in an artefact that is read months later as a record of fact.
    const runtime = scriptedRuntime(completed);
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });

    const report = await reportOf(task(), await deps(runtime, sandbox));

    expect(report.configuration).toEqual({ model: null, budget: null });
  });
});

describe("runBenchTask — the preview a task asked for", () => {
  const PORT = 5173;

  /** A task that expects an application to be serving, plus a build and a lint check. */
  function servingTask() {
    return task(
      [
        { id: "build", command: "bun run build", build: true },
        { id: "lint", command: "bun run lint", category: "code" },
      ],
      { preview: { port: PORT } },
    );
  }

  async function run(sandbox: InMemorySandboxManager) {
    return reportOf(servingTask(), await deps(scriptedRuntime(completed), sandbox));
  }

  it("passes a run whose application serves", async () => {
    const sandbox = new InMemorySandboxManager({
      defaultExec: () => ({ exitCode: 0 }),
      serves: [PORT],
    });

    const report = await run(sandbox);

    expect(report.status).toBe("passed");
    expect(report.gates).toEqual([]);
  });

  it("fails the run when the port is not listening inside the sandbox", async () => {
    // The application did not start. That is a measurement of the agent's work, so the run
    // fails with a score rather than erroring.
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 7 }) });

    const report = await run(sandbox);

    expect(report.status).toBe("failed");
    expect(report.errorKind).toBeNull();
    expect(report.gates).toContain("preview_not_started");
    expect(report.score).not.toBeNull();
  });

  it("errors with kind sandbox when the port is listening but the preview is not reachable", async () => {
    // Same symptom, opposite cause, and the reason this pair exists: without the probe the
    // most likely infrastructure fault in the system would be recorded as the line above.
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });

    const report = await run(sandbox);

    expect(report.status).toBe("errored");
    expect(report.errorKind).toBe("sandbox");
    expect(report.score).toBeNull();
    expect(report.gates).toEqual(["preview_unreachable"]);
  });

  it("runs no check once the preview is known to be unreachable", async () => {
    // Their failures would be the proxy's, recorded against the agent.
    let builds = 0;
    const sandbox = new InMemorySandboxManager({
      defaultExec: (command) => {
        if (command.includes("bun run")) builds++;
        return { exitCode: 0 };
      },
    });

    await run(sandbox);

    expect(builds).toBe(0);
  });

  it("still records every check when the application did not start", async () => {
    // The criterion that stops the sharp edge in docs/adr/0002 from cutting the wrong way:
    // a check that could not be run is *failed*, never omitted. An omitted check drops its
    // category out of the weighting, so an application that never came up would have the
    // categories it could not answer redistributed to the ones it could.
    const sandbox = new InMemorySandboxManager({
      defaultExec: (command) => ({ exitCode: command.startsWith("curl") ? 7 : 1 }),
    });

    const report = await run(sandbox);

    expect(report.checks.map((check) => check.checkId)).toEqual(["build", "lint"]);
    expect(report.checks.every((check) => check.outcome === "failed")).toBe(true);
  });

  it("cannot be scored higher by failing to start than by dropping the checks it broke", async () => {
    // ADR-0002's sharp edge, stated as the comparison that matters. The task has a check in
    // the browser category, which only an application that came up can pass. The app does
    // not come up, so it fails — and the assertion is that recording it as failed scores
    // *lower* than leaving it out would, because leaving it out drops the browser category
    // and hands its share to the categories that did answer.
    const sandbox = new InMemorySandboxManager({
      defaultExec: (command) => ({
        // curl refuses: nothing is listening, so the application never started. The smoke
        // check needs the app; the build and the lint do not.
        exitCode: command.startsWith("curl") || command.includes("smoke") ? 7 : 0,
      }),
    });

    const report = await reportOf(
      task(
        [
          { id: "build", command: "bun run build", build: true },
          { id: "lint", command: "bun run lint", category: "code" },
          { id: "smoke", command: "smoke the page", category: "browser" },
        ],
        { preview: { port: PORT } },
      ),
      await deps(scriptedRuntime(completed), sandbox),
    );

    const dropped = scoreRun(
      report.checks.filter((entry) => entry.checkId !== "smoke"),
      DEFAULT_CATEGORY_WEIGHTS,
    );

    expect(report.checks.map((entry) => entry.outcome)).toEqual(["passed", "passed", "failed"]);
    expect(report.score).toBeLessThan(dropped.overall ?? 0);
    expect(report.status).toBe("failed");
    expect(report.gates).toContain("preview_not_started");
  });

  it("caps a run whose build failed, however well everything else went", async () => {
    const sandbox = new InMemorySandboxManager({
      defaultExec: (command) => ({ exitCode: command.includes("build") ? 1 : 0 }),
      serves: [PORT],
    });

    const report = await reportOf(
      // The build is worth a hundredth of the lint, so the weighted mean is high and the run
      // is still not allowed to look good: the thing it built does not compile.
      task(
        [
          { id: "build", command: "bun run build", build: true, weight: 0.01 },
          { id: "lint", command: "bun run lint", weight: 1 },
        ],
        { preview: { port: PORT } },
      ),
      await deps(scriptedRuntime(completed), sandbox),
    );

    expect(report.status).toBe("failed");
    expect(report.gates).toContain("build_failed");
    expect(report.score).toBe(BUILD_FAILURE_SCORE_CAP);

    // And the report still adds up. A capped headline that could not be derived from the
    // figures printed beside it would undo the property the scoring engine was built for:
    // somebody recomputing the mean would find 99 where the report says 40 and have no way
    // to tell which was wrong.
    const mean = report.categories.reduce(
      (sum, entry) => sum + (entry.score * entry.effectiveWeight) / 100,
      0,
    );
    expect(report.score).toBe(Math.min(Math.round(mean), report.scoreCap ?? 100));
  });

  it("fails a run whose required check failed, however high the score", async () => {
    const sandbox = new InMemorySandboxManager({
      defaultExec: (command) => ({ exitCode: command.includes("renders") ? 1 : 0 }),
      serves: [PORT],
    });

    const report = await reportOf(
      task(
        [
          { id: "renders", command: "test renders", required: true, weight: 0.01 },
          { id: "lint", command: "bun run lint", weight: 1 },
        ],
        { preview: { port: PORT } },
      ),
      await deps(scriptedRuntime(completed), sandbox),
    );

    expect(report.status).toBe("failed");
    expect(report.gates).toEqual(["required_check_failed"]);
    // Not capped — required is not the build gate — so the report still shows a run that
    // did nearly everything right and is a failure anyway.
    expect(report.score).toBe(99);
  });

  it("does not probe a preview for a task that never asked for one", async () => {
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
    const withSandbox = await deps(scriptedRuntime(completed), sandbox);

    await reportOf(task(), withSandbox);

    expect(sandbox.commands(withSandbox.sandboxId).some((c) => c.startsWith("curl"))).toBe(false);
  });
});

/**
 * The browser half of a run, composed rather than executed: the executor has its own tests
 * against the fake, so what matters here is that the runner opens a session per check, points
 * it at the address the preview probe found, and never quietly drops a check it could not run.
 */
describe("runBenchTask — browser checks", () => {
  const PORT = 5173;

  function browserTask(steps: BrowserStep[] = [{ step: "expectText", text: "Todos" }]) {
    const parsed = parseBenchTask({
      id: "todo",
      name: "A todo list",
      prompts: ["Build a todo list."],
      preview: { port: PORT },
      checks: [
        { id: "build", kind: "command", command: "bun run build" },
        { id: "shows-the-list", kind: "browser", steps },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  }

  /** A factory that hands out scripted sessions and keeps them, so a test can inspect them. */
  function browserFactory(options: ScriptedBrowserSessionOptions = {}) {
    const sessions: ScriptedBrowserSession[] = [];
    const factory = async () => {
      const session = new ScriptedBrowserSession(options);
      sessions.push(session);
      return { ok: true as const, value: session };
    };
    return { factory, sessions };
  }

  const serving = () =>
    new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }), serves: [PORT] });

  it("drives the check against the address the preview is actually served at", async () => {
    const sandbox = serving();
    const withSandbox = await deps(scriptedRuntime(completed), sandbox);
    const { factory, sessions } = browserFactory({
      pages: { "/": { elements: [{ text: "Todos" }] } },
    });

    const report = await reportOf(browserTask(), { ...withSandbox, browser: factory });

    expect(report.status).toBe("passed");
    expect(report.checks.map((check) => [check.checkId, check.kind, check.outcome])).toEqual([
      ["build", "command", "passed"],
      ["shows-the-list", "browser", "passed"],
    ]);

    const previewUrl = await sandbox.getPreviewUrl(withSandbox.sandboxId, PORT);
    expect(previewUrl.ok).toBe(true);
    if (previewUrl.ok) {
      expect(sessions[0]?.calls.find((call) => call.method === "goto")?.url).toBe(previewUrl.value);
    }
  });

  it("opens one session per check and closes it afterwards", async () => {
    // Isolation is structural here too: a check that passed because of what the previous one
    // left in local storage is a check measuring the wrong thing.
    const sandbox = serving();
    const { factory, sessions } = browserFactory({
      pages: { "/": { elements: [{ text: "Todos" }] } },
    });

    const parsed = parseBenchTask({
      ...browserTask(),
      checks: [
        { id: "one", kind: "browser", steps: [{ step: "expectText", text: "Todos" }] },
        { id: "two", kind: "browser", steps: [{ step: "expectText", text: "Todos" }] },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error);

    await reportOf(parsed.value, {
      ...(await deps(scriptedRuntime(completed), sandbox)),
      browser: factory,
    });

    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(session.calls.at(-1)?.method).toBe("close");
    }
  });

  it("records a browser check as failed, not absent, when the application never started", async () => {
    // Absent would drop the browser category out of the weighting entirely, so failing to
    // start would *raise* the score. See docs/adr/0002.
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 7 }) });
    const { factory, sessions } = browserFactory();

    const report = await reportOf(browserTask(), {
      ...(await deps(scriptedRuntime(completed), sandbox)),
      browser: factory,
    });

    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.kind === "browser")?.outcome).toBe("failed");
    // And no browser was opened at all: there was nothing at the other end to drive.
    expect(sessions).toHaveLength(0);
  });

  it("errors as configuration when a task needs a browser the run was not given", async () => {
    // Not a failed check: nobody looked at the application, so nothing was observed about it.
    const report = await reportOf(browserTask(), await deps(scriptedRuntime(completed), serving()));

    expect(report.status).toBe("errored");
    expect(report.errorKind).toBe("configuration");
    expect(report.gates).toEqual(["browser_unavailable"]);
    expect(report.score).toBeNull();
  });

  it("errors with kind browser when no browser could be started", async () => {
    const report = await reportOf(browserTask(), {
      ...(await deps(scriptedRuntime(completed), serving())),
      browser: async () => ({
        ok: false as const,
        error: { code: "unavailable" as const, message: "no Chrome at NAP_CHROME_PATH" },
      }),
    });

    expect(report.status).toBe("errored");
    expect(report.errorKind).toBe("browser");
    expect(report.gates).toEqual(["browser_unavailable"]);
  });

  it("errors with kind browser when it never reaches an application the preview probe reached", async () => {
    // The end of the chain this ticket exists for. The preview gate has already proven the URL
    // serves, so a navigation that still fails every attempt is infrastructure — and the run
    // must error with no score rather than record a failed check, which would be a permanent
    // accusation in an archived report against an application nobody actually looked at.
    const { factory } = browserFactory({
      fail: (call) =>
        call.method === "goto"
          ? { code: "navigation_failed", message: "net::ERR_CONNECTION_RESET" }
          : undefined,
    });

    const report = await reportOf(browserTask(), {
      ...(await deps(scriptedRuntime(completed), serving())),
      browser: factory,
    });

    expect(report.status).toBe("errored");
    expect(report.errorKind).toBe("browser");
    expect(report.score).toBeNull();
  });

  it("errors with kind browser when the driver dies part-way through a check", async () => {
    const { factory } = browserFactory({
      fail: (call) =>
        call.method === "isVisible"
          ? { code: "unavailable", message: "the page crashed" }
          : undefined,
    });

    const report = await reportOf(browserTask(), {
      ...(await deps(scriptedRuntime(completed), serving())),
      browser: factory,
    });

    expect(report.errorKind).toBe("browser");
    expect(report.gates).toEqual(["browser_unavailable"]);
  });

  it("fails the check, and not the run, when the application is simply wrong", async () => {
    // The other side of the line above: the browser worked perfectly and the page was not
    // what the task asked for, which is the agent's.
    const { factory } = browserFactory({
      pages: { "/": { elements: [{ text: "Something else" }] } },
    });

    const report = await reportOf(browserTask(), {
      ...(await deps(scriptedRuntime(completed), serving())),
      browser: factory,
    });

    expect(report.status).toBe("failed");
    expect(report.errorKind).toBeNull();
    expect(report.gates).toEqual([]);
    expect(report.checks.find((check) => check.kind === "browser")?.detail).toContain("step 1");
  });
});

/**
 * Screenshots and the visual seam: what a run keeps, and what it says about how it looked.
 *
 * The judge does not exist, so almost all of this is about the artefacts and about `not_run`
 * being an answer rather than a zero — the distinction the whole scale depends on.
 */
describe("runBenchTask — screenshots and visual evaluation", () => {
  const PORT = 5173;

  function shotTask(extras: Record<string, unknown> = {}) {
    const parsed = parseBenchTask({
      id: "todo",
      name: "A todo list",
      prompts: ["Build a todo list."],
      preview: { port: PORT },
      checks: [
        { id: "build", kind: "command", command: "bun run build" },
        {
          id: "shows-the-list",
          kind: "browser",
          viewport: "mobile",
          steps: [{ step: "expectText", text: "Todos" }],
          ...extras,
        },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  }

  const CAPTURED_AT = "2026-08-15T04:05:06.000Z";

  const serving = () =>
    new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }), serves: [PORT] });

  const browserFactory = () => async () => ({
    ok: true as const,
    value: new ScriptedBrowserSession({ pages: { "/": { elements: [{ text: "Todos" }] } } }),
  });

  /** A store that keeps what it was handed, so a test can read the metadata that went with it. */
  function recordingStore() {
    const saved: CapturedScreenshot[] = [];
    const store: ScreenshotStore = async (screenshot) => {
      saved.push(screenshot);
      return { ok: true, value: screenshotFilename(screenshot.metadata) };
    };
    return { store, saved };
  }

  it("photographs each browser check and references it in the report by relative path", async () => {
    const withSandbox = await deps(scriptedRuntime(completed), serving());
    const { store, saved } = recordingStore();

    const report = await reportOf(shotTask(), {
      ...withSandbox,
      browser: browserFactory(),
      screenshots: store,
      now: () => new Date(CAPTURED_AT),
    });

    expect(saved).toHaveLength(1);
    expect(report.screenshots).toEqual([
      {
        checkId: "shows-the-list",
        viewport: { name: "mobile", width: 375, height: 667 },
        path: `todo-${RUN_ID}-shows-the-list.png`,
        capturedAt: CAPTURED_AT,
      },
    ]);
  });

  it("records the size the check actually ran at, not the one it declared", async () => {
    // A check may resize mid-sequence, so the only trustworthy answer comes from the page.
    const withSandbox = await deps(scriptedRuntime(completed), serving());
    const { store, saved } = recordingStore();

    await reportOf(shotTask({ steps: [{ step: "viewport", viewport: "tablet" }] }), {
      ...withSandbox,
      browser: browserFactory(),
      screenshots: store,
    });

    expect(saved[0]?.metadata.viewport).toEqual({ name: "tablet", width: 768, height: 1024 });
  });

  it("carries the check's reference image into the capture's metadata", async () => {
    const withSandbox = await deps(scriptedRuntime(completed), serving());
    const { store, saved } = recordingStore();

    await reportOf(shotTask({ referenceScreenshot: "refs/todo-mobile.png" }), {
      ...withSandbox,
      browser: browserFactory(),
      screenshots: store,
    });

    expect(saved[0]?.metadata.reference).toBe("refs/todo-mobile.png");
  });

  it("names the task, run and check in the metadata written beside the image", async () => {
    const withSandbox = await deps(scriptedRuntime(completed), serving());
    const { store, saved } = recordingStore();

    await reportOf(shotTask(), {
      ...withSandbox,
      browser: browserFactory(),
      screenshots: store,
    });

    expect(saved[0]?.metadata).toMatchObject({
      taskId: "todo",
      runId: RUN_ID,
      checkId: "shows-the-list",
    });
  });

  it("takes no screenshots when nobody supplied somewhere to put them", async () => {
    const withSandbox = await deps(scriptedRuntime(completed), serving());

    const report = await reportOf(shotTask(), { ...withSandbox, browser: browserFactory() });

    expect(report.screenshots).toEqual([]);
    expect(report.status).toBe("passed");
  });

  it("does not change a score when a screenshot could not be stored", async () => {
    // An image is evidence about a run, not an observation of the application. A full disk
    // must degrade the report rather than fail a run that has already paid for a model.
    const withSandbox = await deps(scriptedRuntime(completed), serving());
    const failing: ScreenshotStore = async () => ({ ok: false, error: "no space left on device" });

    const report = await reportOf(shotTask(), {
      ...withSandbox,
      browser: browserFactory(),
      screenshots: failing,
    });

    expect(report.status).toBe("passed");
    expect(report.score).toBe(100);
    expect(report.screenshots).toEqual([]);
  });

  it("reports visual as not_run by default, and leaves the category renormalised away", async () => {
    const withSandbox = await deps(scriptedRuntime(completed), serving());

    const report = await reportOf(shotTask(), { ...withSandbox, browser: browserFactory() });

    expect(report.visual).toEqual(VISUAL_NOT_RUN);
    expect(report.categories.map((entry) => entry.category)).not.toContain("visual");
    // The point of not_run not being zero: a run nobody judged can still be perfect.
    expect(report.score).toBe(100);
  });

  it("scores the visual category when a manual judgement was supplied", async () => {
    const withSandbox = await deps(scriptedRuntime(completed), serving());

    const report = await reportOf(shotTask(), {
      ...withSandbox,
      browser: browserFactory(),
      visual: manualVisualEvaluation({ score: 40, source: "manual:mr" }),
    });

    expect(report.visual).toEqual({ status: "scored", score: 40, source: "manual:mr" });
    // The task declares no code check, so three categories renormalise over 50/25/15 rather
    // than four over the full vector: 55.6 / 27.8 / 16.7.
    expect(report.categories).toContainEqual({
      category: "visual",
      score: 40,
      effectiveWeight: 16.7,
      checks: 0,
    });
    // Functional and browser at 100 carrying 83.4, visual at 40 carrying 16.7.
    expect(report.score).toBe(90);
  });

  it("shows a judge what it photographed", async () => {
    const withSandbox = await deps(scriptedRuntime(completed), serving());
    const { store } = recordingStore();
    const seen: VisualEvaluationInput[] = [];

    await reportOf(shotTask(), {
      ...withSandbox,
      browser: browserFactory(),
      screenshots: store,
      visual: {
        evaluate: async (input) => {
          seen.push(input);
          return VISUAL_NOT_RUN;
        },
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ taskId: "todo", runId: RUN_ID });
    expect(seen[0]?.screenshots.map((shot) => shot.checkId)).toEqual(["shows-the-list"]);
  });

  it("still reports a visual verdict on a run that never reached a browser", async () => {
    // Every report has the field, whatever path the run took out — a reader must be able to
    // tell "not evaluated" from "this report predates the field".
    const withSandbox = await deps(
      scriptedRuntime({
        ok: false,
        turnId: TURN_ID,
        reason: "model_unavailable",
        message: "the provider was unreachable",
      }),
      serving(),
    );

    const report = await reportOf(shotTask(), { ...withSandbox, browser: browserFactory() });

    expect(report.status).toBe("errored");
    expect(report.visual).toEqual(VISUAL_NOT_RUN);
    expect(report.screenshots).toEqual([]);
  });
});

describe("runBenchTask — a screenshot at a size that is none of ours", () => {
  const PORT = 5173;

  it("records a null name rather than guessing one from the declaration", async () => {
    // The one case the nullable name exists for. A check declared `mobile` and resized itself
    // to something unnamed: filing that image as `mobile` would be a lie shaped like a
    // measurement, and the declaration is not evidence about the page that was photographed.
    const sandbox = new InMemorySandboxManager({
      defaultExec: () => ({ exitCode: 0 }),
      serves: [PORT],
    });
    const withSandbox = await deps(scriptedRuntime(completed), sandbox);

    const parsed = parseBenchTask({
      id: "todo",
      name: "A todo list",
      prompts: ["Build a todo list."],
      preview: { port: PORT },
      checks: [
        {
          id: "odd-size",
          kind: "browser",
          viewport: "mobile",
          steps: [{ step: "expectText", text: "Todos" }],
        },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error);

    const saved: CapturedScreenshot[] = [];
    await reportOf(parsed.value, {
      ...withSandbox,
      browser: async () => {
        const session = new ScriptedBrowserSession({
          pages: { "/": { elements: [{ text: "Todos" }] } },
        });
        // Overridden rather than driven through a step, because the executor can only ever set
        // a *named* size — an unnamed one is what a page does to itself, which is precisely the
        // case the nullable name exists for and precisely what the fake cannot reach.
        session.screenshot = async () => ({
          ok: true,
          value: { bytes: new Uint8Array([1]), viewport: { width: 800, height: 900 } },
        });
        return { ok: true as const, value: session };
      },
      screenshots: async (screenshot) => {
        saved.push(screenshot);
        return { ok: true, value: "odd.png" };
      },
    });

    expect(saved[0]?.metadata.viewport).toEqual({ name: null, width: 800, height: 900 });
  });
});

/**
 * Prompt sequences and seeded starting state — the two things a task needs before the agent
 * runs, and the only two places the runner touches the sandbox on the agent's behalf.
 */
describe("runBenchTask — prompts in sequence", () => {
  function twoPrompts(prompts: string[]) {
    const parsed = parseBenchTask({
      id: "todo",
      name: "A todo list",
      prompts,
      checks: [{ id: "build", kind: "command", command: "bun run build" }],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  }

  it("sends each prompt as its own turn, in order", async () => {
    const runtime = scriptedRuntime(completed);
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });

    await reportOf(twoPrompts(["Build it.", "Now filter it."]), await deps(runtime, sandbox));

    expect(runtime.messages).toEqual(["Build it.", "Now filter it."]);
  });

  it("stops at the first turn that fails, rather than talking past a broken run", async () => {
    // The follow-up is written against what the first prompt was supposed to produce. Sending
    // it after a failure would measure the agent against a workspace that is not the one the
    // prompt describes, and pay for the turn to do it.
    const messages: string[] = [];
    const runtime: Runtime = {
      async runTurn(request) {
        messages.push(request.message);
        return messages.length === 1
          ? { ok: false, turnId: TURN_ID, reason: "model_unavailable", message: "down" }
          : completed;
      },
      async resumeSession() {
        throw new Error("the runner must not resume a session");
      },
    };
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });

    const report = await reportOf(twoPrompts(["Build it.", "Now filter it."]), {
      ...(await deps(runtime, sandbox)),
    });

    expect(messages).toEqual(["Build it."]);
    expect(report.status).toBe("errored");
  });

  it("records the last turn attempted, which is the one the verdict is about", async () => {
    const secondTurn = "3f2a1c4e-0000-4000-8000-00000000dead";
    const seen: string[] = [];
    const runtime: Runtime = {
      async runTurn(request) {
        seen.push(request.message);
        return { ok: true, turnId: seen.length === 1 ? TURN_ID : secondTurn, commitSha: null };
      },
      async resumeSession() {
        throw new Error("the runner must not resume a session");
      },
    };
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });

    const report = await reportOf(
      twoPrompts(["Build it.", "Now filter it."]),
      await deps(runtime, sandbox),
    );

    expect(report.turnId).toBe(secondTurn);
  });
});

describe("runBenchTask — seeded files", () => {
  function seededTask(files: { path: string; contents: string }[]) {
    const parsed = parseBenchTask({
      id: "debug",
      name: "Fix it",
      prompts: ["The list does not render. Fix it."],
      environment: { files },
      checks: [{ id: "build", kind: "command", command: "bun run build" }],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  }

  it("writes the files into the project before the agent is asked anything", async () => {
    // The ordering is the whole claim, so it is read from *inside* the turn: what the agent
    // could see at the moment it was asked. Reading the file after the run instead would pass
    // just as happily if the files had landed second, which is the thing being ruled out.
    let visibleToTheAgent: string | null = null;
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
    let sandboxId = "";
    const runtime: Runtime = {
      async runTurn() {
        const seen = await sandbox.readFile(sandboxId, `${PROJECT_ROOT_PATH}/src/App.tsx`);
        visibleToTheAgent = seen.ok ? seen.value : null;
        return completed;
      },
      async resumeSession() {
        throw new Error("the runner must not resume a session");
      },
    };
    const withSandbox = await deps(runtime, sandbox);
    sandboxId = withSandbox.sandboxId;

    await reportOf(seededTask([{ path: "src/App.tsx", contents: "broken" }]), withSandbox);

    expect(visibleToTheAgent).toBe("broken");
  });

  it("creates a sandbox to seed into when the session has none, and records it", async () => {
    // The ordinary case, and the one the whole arrangement exists for: the runtime opens a
    // sandbox on the first turn, which is too late for files the agent is supposed to *read*.
    // Seeding opens one first and writes it down, so the turn resumes that one rather than
    // opening a second and leaving the seeded files in an orphan nobody looks at.
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
    const sessions = new InMemorySessionStore([
      { sessionId: SESSION_ID, projectId: crypto.randomUUID() },
    ]);

    const report = await reportOf(seededTask([{ path: "src/App.tsx", contents: "broken" }]), {
      runtime: scriptedRuntime(completed),
      sandbox,
      sessions,
      events: new InMemoryEventStore(),
      sessionId: SESSION_ID,
      runId: RUN_ID,
    });

    const recorded = (await sessions.get(SESSION_ID))?.sandboxId;
    expect(recorded).toBeDefined();
    expect(report.gates).not.toContain("seed_failed");

    if (recorded != null) {
      const seeded = await sandbox.readFile(recorded, `${PROJECT_ROOT_PATH}/src/App.tsx`);
      expect(seeded.ok && seeded.value).toBe("broken");
    }
  });

  it("errors when no sandbox could be created to seed into", async () => {
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
    sandbox.create = async () => ({
      ok: false,
      error: { code: "unavailable", message: "no capacity" },
    });
    const runtime = scriptedRuntime(completed);

    const report = await reportOf(seededTask([{ path: "src/App.tsx", contents: "broken" }]), {
      runtime,
      sandbox,
      sessions: new InMemorySessionStore([
        { sessionId: SESSION_ID, projectId: crypto.randomUUID() },
      ]),
      events: new InMemoryEventStore(),
      sessionId: SESSION_ID,
      runId: RUN_ID,
    });

    expect(report.gates).toContain("seed_failed");
    expect(report.errorKind).toBe("sandbox");
    expect(runtime.messages).toEqual([]);
  });

  it("blames configuration, not the sandbox, when the session does not exist", async () => {
    // The same fact the workspace gate reports after a turn. It would be absurd for "no such
    // session" to be a configuration error on a task that seeds nothing and an infrastructure
    // one on a task that seeds.
    const report = await reportOf(seededTask([{ path: "src/App.tsx", contents: "broken" }]), {
      runtime: scriptedRuntime(completed),
      sandbox: new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) }),
      sessions: new InMemorySessionStore([]),
      events: new InMemoryEventStore(),
      sessionId: SESSION_ID,
      runId: RUN_ID,
    });

    expect(report.gates).toEqual(["workspace_missing"]);
    expect(report.errorKind).toBe("configuration");
  });

  it("joins the path against the project root, so a task never names the sandbox layout", async () => {
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
    const withSandbox = await deps(scriptedRuntime(completed), sandbox);

    await reportOf(seededTask([{ path: "src/lib/todo.ts", contents: "x" }]), withSandbox);

    const seeded = await sandbox.readFile(
      withSandbox.sandboxId,
      `${PROJECT_ROOT_PATH}/src/lib/todo.ts`,
    );
    expect(seeded.ok).toBe(true);
  });

  it("errors the run when a file could not be seeded, blaming the sandbox and not the agent", async () => {
    // The agent never saw the starting state the task declared, so whatever it did next is not
    // evidence about it. Infrastructure, per the rule that doubt resolves that way.
    const runtime = scriptedRuntime(completed);
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
    const withSandbox = await deps(runtime, sandbox);
    sandbox.writeFile = async () => ({
      ok: false,
      error: { code: "unavailable", message: "the sandbox went away" },
    });

    const report = await reportOf(
      seededTask([{ path: "src/App.tsx", contents: "broken" }]),
      withSandbox,
    );

    expect(report.status).toBe("errored");
    expect(report.errorKind).toBe("sandbox");
    expect(report.gates).toContain("seed_failed");
    expect(report.score).toBeNull();
    // And nothing was asked of the agent, because there was nothing to ask it about.
    expect(runtime.messages).toEqual([]);
  });

  it("seeds nothing and creates nothing when the task declares no environment", async () => {
    const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
    const withSandbox = await deps(scriptedRuntime(completed), sandbox);

    const report = await reportOf(task(), withSandbox);

    expect(report.status).toBe("passed");
    expect(report.gates).not.toContain("seed_failed");
  });
});

/**
 * The accessibility half. It needs a browser exactly as a browser check does, so what is
 * proved here is that the runner treats it that way — including in the two places where
 * treating it as anything else would quietly change a score.
 */
describe("runBenchTask — accessibility checks", () => {
  const PORT = 5173;

  function auditTask() {
    const parsed = parseBenchTask({
      id: "landing",
      name: "A landing page",
      prompts: ["Build a landing page."],
      preview: { port: PORT },
      checks: [
        { id: "build", kind: "command", command: "bun run build" },
        { id: "is-accessible", kind: "accessibility" },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  }

  const serving = () =>
    new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }), serves: [PORT] });

  function browserFactory(options: ScriptedBrowserSessionOptions = {}) {
    const sessions: ScriptedBrowserSession[] = [];
    const factory = async () => {
      const session = new ScriptedBrowserSession(options);
      sessions.push(session);
      return { ok: true as const, value: session };
    };
    return { factory, sessions };
  }

  it("audits the running application and records what the tool said", async () => {
    const withSandbox = await deps(scriptedRuntime(completed), serving());
    const { factory, sessions } = browserFactory({
      pages: {
        "/": {
          violations: [
            {
              id: "image-alt",
              impact: "critical",
              help: "Images must have alternate text",
              helpUrl: "https://example.test/image-alt",
              nodes: 2,
            },
          ],
        },
      },
    });

    const report = await reportOf(auditTask(), { ...withSandbox, browser: factory });

    expect(report.checks.map((check) => [check.checkId, check.kind, check.outcome])).toEqual([
      ["build", "command", "passed"],
      ["is-accessible", "accessibility", "failed"],
    ]);
    expect(report.checks[1]?.detail).toMatch(/image-alt/);
    // A session of its own, closed after it, exactly as a browser check gets.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.calls.map((call) => call.method)).toContain("scanAccessibility");
  });

  it("scores a clean audit into the code category, so it is not free browser marks", async () => {
    const withSandbox = await deps(scriptedRuntime(completed), serving());
    const { factory } = browserFactory({ pages: { "/": {} } });

    const report = await reportOf(auditTask(), { ...withSandbox, browser: factory });

    expect(report.status).toBe("passed");
    expect(report.checks[1]?.category).toBe("code");
  });

  it("records the audit as failed, not absent, when the application never served", async () => {
    // The rule ADR-0002 calls the sharp edge: absent renormalises the category away, so an
    // application that does not start would have its accessibility weight handed to the
    // categories that did run — and failing to start would raise the score.
    const withSandbox = await deps(
      scriptedRuntime(completed),
      new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 7 }) }),
    );
    const { factory, sessions } = browserFactory();

    const report = await reportOf(auditTask(), { ...withSandbox, browser: factory });

    const audit = report.checks.find((check) => check.checkId === "is-accessible");
    expect(audit?.outcome).toBe("failed");
    // Recorded as what it is. A report is read without its task beside it, and an audit
    // filed as a browser check could not be counted as an audit later.
    expect(audit?.kind).toBe("accessibility");
    expect(sessions).toHaveLength(0);
  });

  it("errors the run rather than blaming the agent when no browser was configured", async () => {
    // `configuration`, not `browser`: the task declares an audit and whoever composed the run
    // gave it nothing to audit with. That is a run set up wrong, and it is a different finding
    // from a browser that would not start — which is the one `browser` is reserved for.
    const withSandbox = await deps(scriptedRuntime(completed), serving());

    const report = await reportOf(auditTask(), withSandbox);

    expect(report.status).toBe("errored");
    expect(report.errorKind).toBe("configuration");
    expect(report.score).toBeNull();
    expect(report.gates).toContain("browser_unavailable");
  });
});
