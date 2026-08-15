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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NapAgentService } from "@nap/agent/agent-service";
import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { DEFAULT_CATEGORY_WEIGHTS } from "@nap/bench/category";
import { parseBenchReport } from "@nap/bench/report";
import { runBenchTask } from "@nap/bench/runner";
import { parseScreenshotMetadata } from "@nap/bench/screenshot";
import { defineTask } from "@nap/bench/task";
import { TRACER_TASK } from "@nap/bench/tasks/tracer";
import { ScriptedBrowserSession } from "@nap/bench/testing/scripted-browser-session";
import { parseBenchTrajectory } from "@nap/bench/trajectory";
import { manualVisualEvaluation, VISUAL_NOT_RUN } from "@nap/bench/visual";
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
import { writeBenchReport, writeBenchTrajectory } from "./write-report.ts";
import { fileScreenshotStore } from "./write-screenshot.ts";

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
  // The same store the runtime writes its events to is the one the run reads its trajectory
  // back out of. That is the whole claim of docs/adr/0003 in one line: there is one log.
  const events = new InMemoryEventStore();
  const runtime = new SingleAgentRuntime({
    sessions,
    sandbox,
    context: new NapContextEngine({ budgetTokens: 40_000 }),
    agent: new NapAgentService({ provider: scriptedModel(), budget: { maxSteps: 8 } }),
    events,
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
  });
  return { runtime, sessions, events };
}

describe("a task run end to end", () => {
  it("goes from a task to a scored report file", async () => {
    const sessionId = crypto.randomUUID();
    const sandbox = sandboxWhereBuildSucceeds(0);
    const { runtime, sessions, events } = composeRuntime(sandbox, sessionId);

    const { report, trajectory } = await runBenchTask(TRACER_TASK, {
      runtime,
      sandbox,
      sessions,
      events,
      sessionId,
    });
    const path = await writeBenchReport(resultsDir, report);
    const trajectoryFile = await writeBenchTrajectory(resultsDir, trajectory);

    expect(report.status).toBe("passed");
    expect(report.score).toBe(100);
    expect(report.taskId).toBe("tracer");
    // The effective vector is recorded, and it is not the configured one: with nothing
    // scoring into browser or visual, functional and code carry the whole run between them.
    expect(report.weights).toEqual(DEFAULT_CATEGORY_WEIGHTS);
    expect(report.categories.map((entry) => entry.effectiveWeight)).toEqual([83.3, 16.7]);

    // Derived from the events the real runtime wrote, not from a second instrumentation
    // path: one tool call to write the file, one turn, and the tokens the model reported.
    expect(report.metrics.toolCalls).toBe(1);
    expect(report.metrics.filesChanged).toBe(1);
    expect(report.metrics.turns).toEqual({ started: 1, completed: 1, failed: 0, cancelled: 0 });
    expect(report.metrics.tokens).toEqual({ inputTokens: 1_900, outputTokens: 60 });

    // Both files on disk are the deliverable, and both have to survive being read back.
    const readBack = parseBenchReport(JSON.parse(readFileSync(path, "utf8")));
    expect(readBack.ok).toBe(true);
    if (readBack.ok) expect(readBack.value).toEqual(report);

    const readBackTrajectory = parseBenchTrajectory(
      JSON.parse(readFileSync(trajectoryFile, "utf8")),
    );
    expect(readBackTrajectory.ok).toBe(true);
    if (readBackTrajectory.ok) {
      expect(readBackTrajectory.value.events).toEqual(await events.readFrom(sessionId, 0));
    }
  });

  it("writes the agent's file into the sandbox the checks then run in", async () => {
    // Proof that the run is one thing rather than two: the check reads the workspace the
    // turn just wrote to, not a fresh one.
    const sessionId = crypto.randomUUID();
    const sandbox = sandboxWhereBuildSucceeds(0);
    const { runtime, sessions, events } = composeRuntime(sandbox, sessionId);

    await runBenchTask(TRACER_TASK, { runtime, sandbox, sessions, events, sessionId });

    const sandboxId = (await sessions.get(sessionId))?.sandboxId;
    if (sandboxId == null) throw new Error("the turn left no sandbox behind");
    const written = await sandbox.readFile(sandboxId, `${PROJECT_ROOT_PATH}/src/App.tsx`);
    expect(written.ok).toBe(true);
    if (written.ok) expect(written.value).toContain("Hello from NapBench");
  });

  it("fails the run when the build the task checks does not pass", async () => {
    const sessionId = crypto.randomUUID();
    const sandbox = sandboxWhereBuildSucceeds(1);
    const { runtime, sessions, events } = composeRuntime(sandbox, sessionId);

    const { report } = await runBenchTask(TRACER_TASK, {
      runtime,
      sandbox,
      sessions,
      events,
      sessionId,
    });

    expect(report.status).toBe("failed");
    // Failed, not errored: the turn ran fine and the application it produced is broken,
    // which is a measurement rather than an absence of one.
    expect(report.checks[0]?.detail).toBe("exit 1");

    // Not zero, and the arithmetic is the point: functional scored 0 and code scored 100,
    // weighted 50 and 10, renormalised over the two categories present → 100 * (10/60) = 17.
    // A broken build still sinks the run without pretending the lint result did not happen.
    expect(report.score).toBe(17);
    expect(report.categories).toEqual([
      { category: "functional", score: 0, effectiveWeight: 83.3, checks: 1 },
      { category: "code", score: 100, effectiveWeight: 16.7, checks: 1 },
    ]);
  });
});

/**
 * The screenshot half, joined the same way: a real run, a real file on disk, and a report whose
 * path actually resolves.
 *
 * Separate from the tracer task because that one declares no preview and opens no browser. The
 * browser is the scripted fake rather than Chrome — what is being proved here is the *wiring*
 * between the runner, the store and the report, and `PlaywrightBrowserSession` has its own
 * integration test against real Chrome for the part a fake cannot stand in for.
 */
describe("screenshots, from a run to a file the report can be read against", () => {
  const shotTask = defineTask({
    id: "shot",
    name: "A page worth photographing",
    prompts: ["Build a landing page."],
    preview: { port: TEMPLATE_DEV_PORT },
    checks: [
      {
        id: "shows-the-heading",
        kind: "browser",
        viewport: "mobile",
        steps: [{ step: "expectText", text: "Hello" }],
        referenceScreenshot: "refs/shot-mobile.png",
      },
    ],
  });

  const browser = async () => ({
    ok: true as const,
    value: new ScriptedBrowserSession({
      pages: { "/": { elements: [{ text: "Hello from NapBench" }] } },
      screenshotBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    }),
  });

  it("writes the image and its metadata where the report says they are", async () => {
    const sessionId = crypto.randomUUID();
    const sandbox = sandboxWhereBuildSucceeds(0);
    const { runtime, sessions, events } = composeRuntime(sandbox, sessionId);

    const { report } = await runBenchTask(shotTask, {
      runtime,
      sandbox,
      sessions,
      events,
      sessionId,
      browser,
      screenshots: fileScreenshotStore(resultsDir),
    });
    const reportFile = await writeBenchReport(resultsDir, report);

    expect(report.status).toBe("passed");
    expect(report.screenshots).toHaveLength(1);

    const ref = report.screenshots[0];
    if (ref === undefined) throw new Error("the run recorded no screenshot");
    expect(ref.checkId).toBe("shows-the-heading");
    expect(ref.viewport).toEqual({ name: "mobile", width: 375, height: 667 });

    // The claim the whole ticket rests on: the path in the report resolves, against the
    // directory the report itself was written to.
    const resolved = join(dirname(reportFile), ref.path);
    expect(new Uint8Array(readFileSync(resolved))).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );

    // And the sidecar beside it says what the image is, without the report in hand.
    const sidecar = parseScreenshotMetadata(JSON.parse(readFileSync(`${resolved}.json`, "utf8")));
    expect(sidecar.ok).toBe(true);
    if (sidecar.ok) {
      expect(sidecar.value.taskId).toBe("shot");
      expect(sidecar.value.runId).toBe(report.runId);
      expect(sidecar.value.reference).toBe("refs/shot-mobile.png");
    }
  });

  it("leaves visual not run, and the category renormalised out of the score", async () => {
    const sessionId = crypto.randomUUID();
    const sandbox = sandboxWhereBuildSucceeds(0);
    const { runtime, sessions, events } = composeRuntime(sandbox, sessionId);

    const { report } = await runBenchTask(shotTask, {
      runtime,
      sandbox,
      sessions,
      events,
      sessionId,
      browser,
      screenshots: fileScreenshotStore(resultsDir),
    });

    expect(report.visual).toEqual(VISUAL_NOT_RUN);
    expect(report.categories.map((entry) => entry.category)).toEqual(["browser"]);
    // Not 85. A run nobody judged visually is scored over what was measured.
    expect(report.score).toBe(100);
  });

  it("scores the visual category from a hand-supplied judgement, and still writes the image", async () => {
    const sessionId = crypto.randomUUID();
    const sandbox = sandboxWhereBuildSucceeds(0);
    const { runtime, sessions, events } = composeRuntime(sandbox, sessionId);

    const { report } = await runBenchTask(shotTask, {
      runtime,
      sandbox,
      sessions,
      events,
      sessionId,
      browser,
      screenshots: fileScreenshotStore(resultsDir),
      visual: manualVisualEvaluation({ score: 50, source: "manual:mr", notes: "plain" }),
    });

    expect(report.visual).toMatchObject({ status: "scored", score: 50, source: "manual:mr" });
    // Browser at 100 weighted 25, visual at 50 weighted 15 → 62.5 / 37.5 renormalised.
    expect(report.categories).toEqual([
      { category: "browser", score: 100, effectiveWeight: 62.5, checks: 1 },
      { category: "visual", score: 50, effectiveWeight: 37.5, checks: 0 },
    ]);
    expect(report.score).toBe(81);
    expect(report.screenshots).toHaveLength(1);
  });

  it("does not lose the run when the screenshots cannot be written", async () => {
    const sessionId = crypto.randomUUID();
    const sandbox = sandboxWhereBuildSucceeds(0);
    const { runtime, sessions, events } = composeRuntime(sandbox, sessionId);

    // A file where the directory needs to be: every write fails, and the run must not care.
    const blocked = join(resultsDir, "blocked");
    writeFileSync(blocked, "not a directory");

    const { report } = await runBenchTask(shotTask, {
      runtime,
      sandbox,
      sessions,
      events,
      sessionId,
      browser,
      screenshots: fileScreenshotStore(blocked),
    });

    expect(report.status).toBe("passed");
    expect(report.score).toBe(100);
    expect(report.screenshots).toEqual([]);
  });
});
