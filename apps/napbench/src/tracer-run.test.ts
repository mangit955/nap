/**
 * The tracer bullet, joined up: a real `SingleAgentRuntime` driven by a scripted model, a
 * real task, and a report file on disk at the end.
 *
 * Every other test in this slice covers one piece against a stub. This is the one that proves
 * the pieces compose — which is the whole claim the ticket makes, and the claim a set of green
 * unit tests can most easily fail to support.
 *
 * It lives in the app rather than in `@nap/bench` because composing a Runtime is precisely
 * what the app is for: the pure core may not depend on `@nap/runtime`, per docs/adr/0001.
 *
 * Costs nothing and touches no network: the model is scripted, the sandbox is in memory, the
 * event store is in memory, and the only real resource is a temporary directory.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NapAgentService } from "@nap/agent/agent-service";
import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { parseBenchReport } from "@nap/bench/report";
import { runBenchTask } from "@nap/bench/runner";
import { TRACER_TASK } from "@nap/bench/tasks/tracer";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { SingleAgentRuntime } from "@nap/runtime/single-agent-runtime";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeBenchReport } from "./write-report.ts";

let resultsDir: string;

beforeEach(() => {
  resultsDir = mkdtempSync(join(tmpdir(), "napbench-tracer-"));
});

afterEach(() => {
  rmSync(resultsDir, { recursive: true, force: true });
});

/** A model that edits the heading and then answers — one tool call, then prose. */
function scriptedModel() {
  return new ScriptedLLMProvider([
    [
      {
        text: "I'll change the heading.",
        toolCalls: [
          {
            id: "call_1",
            name: "write_file",
            input: {
              path: `${PROJECT_ROOT_PATH}/src/App.tsx`,
              contents:
                "export default function App() {\n  return <h1>Hello from NapBench</h1>;\n}\n",
            },
          },
        ],
        usage: { inputTokens: 900, outputTokens: 40 },
      },
      {
        text: "Done — the heading now reads 'Hello from NapBench'.",
        usage: { inputTokens: 1_000, outputTokens: 20 },
      },
    ],
  ]);
}

/** A sandbox answering the commands a turn runs, plus whatever the task's check asks. */
function sandboxWhereBuildSucceeds(buildExitCode: number) {
  return (
    new InMemorySandboxManager({
      defaultExec: () => ({ exitCode: 0, stdout: "" }),
      serves: [TEMPLATE_DEV_PORT],
    })
      // Non-zero means the index differs from HEAD, which is what makes a commit happen.
      .script(/git diff --cached --quiet/, { exitCode: 1 })
      .script(/git rev-parse HEAD/, { exitCode: 0, stdout: `${"0".repeat(40)}\n` })
      .script(/bun run build/, { exitCode: buildExitCode, stdout: "vite build" })
  );
}

function composeRuntime(sandbox: InMemorySandboxManager, sessionId: string) {
  const sessions = new InMemorySessionStore([{ sessionId, projectId: crypto.randomUUID() }]);
  const runtime = new SingleAgentRuntime({
    sessions,
    sandbox,
    context: new NapContextEngine({ budgetTokens: 40_000 }),
    agent: new NapAgentService({ provider: scriptedModel(), budget: { maxSteps: 8 } }),
    events: new InMemoryEventStore(),
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
  });
  return { runtime, sessions };
}

describe("a task run end to end", () => {
  it("goes from a task to a scored report file", async () => {
    const sessionId = crypto.randomUUID();
    const sandbox = sandboxWhereBuildSucceeds(0);
    const { runtime, sessions } = composeRuntime(sandbox, sessionId);

    const report = await runBenchTask(TRACER_TASK, { runtime, sandbox, sessions, sessionId });
    const path = await writeBenchReport(resultsDir, report);

    expect(report.status).toBe("passed");
    expect(report.score).toBe(100);
    expect(report.taskId).toBe("tracer");

    // The file on disk is the deliverable, and it has to survive being read back.
    const readBack = parseBenchReport(JSON.parse(readFileSync(path, "utf8")));
    expect(readBack.ok).toBe(true);
    if (readBack.ok) expect(readBack.value).toEqual(report);
  });

  it("writes the agent's file into the sandbox the checks then run in", async () => {
    // Proof that the run is one thing rather than two: the check reads the workspace the
    // turn just wrote to, not a fresh one.
    const sessionId = crypto.randomUUID();
    const sandbox = sandboxWhereBuildSucceeds(0);
    const { runtime, sessions } = composeRuntime(sandbox, sessionId);

    await runBenchTask(TRACER_TASK, { runtime, sandbox, sessions, sessionId });

    const sandboxId = (await sessions.get(sessionId))?.sandboxId;
    if (sandboxId == null) throw new Error("the turn left no sandbox behind");
    const written = await sandbox.readFile(sandboxId, `${PROJECT_ROOT_PATH}/src/App.tsx`);
    expect(written.ok).toBe(true);
    if (written.ok) expect(written.value).toContain("Hello from NapBench");
  });

  it("fails the run when the build the task checks does not pass", async () => {
    const sessionId = crypto.randomUUID();
    const sandbox = sandboxWhereBuildSucceeds(1);
    const { runtime, sessions } = composeRuntime(sandbox, sessionId);

    const report = await runBenchTask(TRACER_TASK, { runtime, sandbox, sessions, sessionId });

    expect(report.status).toBe("failed");
    expect(report.score).toBe(0);
    // Failed, not errored: the turn ran fine and the application it produced is broken,
    // which is a measurement rather than an absence of one.
    expect(report.checks[0]?.detail).toBe("exit 1");
  });
});
