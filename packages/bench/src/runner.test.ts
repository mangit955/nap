/**
 * The runner, against ports alone — the in-memory sandbox and a scripted Runtime.
 *
 * No network, no model, no Postgres: the whole point of putting the runner in the pure
 * package is that the composition it performs can be driven from a test this cheap.
 */

import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { Runtime, TurnOutcome } from "@nap/shared/ports/runtime";
import { describe, expect, it } from "vitest";
import { runBenchTask } from "./runner.ts";
import { parseBenchTask } from "./task.ts";

const SESSION_ID = "3f2a1c4e-0000-4000-8000-000000000002";
const TURN_ID = "3f2a1c4e-0000-4000-8000-000000000003";
const RUN_ID = "3f2a1c4e-0000-4000-8000-000000000001";
// The in-memory sandbox only answers for sandboxes it created itself, so every test that
// wants a check to run has to create one and seed the session with *that* id.

function task(
  checks: { id: string; command: string }[] = [{ id: "build", command: "bun run build" }],
) {
  const parsed = parseBenchTask({
    id: "landing-page",
    name: "A landing page",
    prompt: "Build a landing page.",
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
    sessionId: SESSION_ID,
    runId: RUN_ID,
    sandboxId: created.value.id,
  };
}

const completed: TurnOutcome = { ok: true, turnId: TURN_ID, commitSha: "a".repeat(40) };

describe("runBenchTask", () => {
  it("sends the task's prompt through the Runtime", async () => {
    const runtime = scriptedRuntime(completed);
    const sandbox = new InMemorySandboxManager({
      defaultExec: () => ({ exitCode: 0, stdout: "" }),
    });

    await runBenchTask(task(), await deps(runtime, sandbox));

    expect(runtime.messages).toEqual(["Build a landing page."]);
  });

  it("passes a run whose command check exits zero", async () => {
    const sandbox = new InMemorySandboxManager().script(/bun run build/, {
      exitCode: 0,
      stdout: "built",
    });

    const report = await runBenchTask(task(), await deps(scriptedRuntime(completed), sandbox));

    expect(report.status).toBe("passed");
    expect(report.score).toBe(100);
    expect(report.checks).toEqual([
      { checkId: "build", kind: "command", passed: true, detail: "exit 0" },
    ]);
  });

  it("fails a run whose command check exits non-zero", async () => {
    const sandbox = new InMemorySandboxManager().script(/bun run build/, {
      exitCode: 1,
      stderr: "type error",
    });

    const report = await runBenchTask(task(), await deps(scriptedRuntime(completed), sandbox));

    expect(report.status).toBe("failed");
    expect(report.score).toBe(0);
    expect(report.checks[0]?.passed).toBe(false);
  });

  it("runs every check, not just up to the first failure", async () => {
    // A report that stopped at the first failure would say nothing about the rest, and
    // the score would depend on the order the checks happen to be declared in.
    const sandbox = new InMemorySandboxManager()
      .script(/build/, { exitCode: 1 })
      .script(/lint/, { exitCode: 0 });

    const report = await runBenchTask(
      task([
        { id: "build", command: "bun run build" },
        { id: "lint", command: "bun run lint" },
      ]),
      await deps(scriptedRuntime(completed), sandbox),
    );

    expect(report.checks.map((check) => check.checkId)).toEqual(["build", "lint"]);
    expect(report.score).toBe(50);
  });

  it("records the run, session and turn ids as three separate things", async () => {
    const sandbox = new InMemorySandboxManager({
      defaultExec: () => ({ exitCode: 0, stdout: "" }),
    });

    const report = await runBenchTask(task(), await deps(scriptedRuntime(completed), sandbox));

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

    const report = await runBenchTask(task(), await deps(runtime, sandbox));

    expect(report.status).toBe("errored");
    expect(report.score).toBeNull();
    expect(report.checks).toEqual([]);
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

    await runBenchTask(
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

    const report = await runBenchTask(task(), withoutSandbox);

    expect(report.status).toBe("errored");
    expect(report.score).toBeNull();
  });

  it("records a check the sandbox refused to run as failed, not as absent", async () => {
    // An unreachable sandbox mid-run is an infrastructure fault, and classifying it as one
    // is what the gate ladder will do. Until then it must at least be visible: dropping the
    // check would raise the score of a run that could not be measured.
    const sandbox = new InMemorySandboxManager({
      defaultExec: () => ({ exitCode: 0, stdout: "" }),
    });
    const withSandbox = await deps(scriptedRuntime(completed), sandbox);
    await sandbox.destroy(withSandbox.sandboxId);

    const report = await runBenchTask(task(), withSandbox);

    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]?.passed).toBe(false);
    expect(report.status).toBe("failed");
  });
});
