/**
 * What an app test is judged against after somebody presses **Fix it**.
 *
 * A Fix it is an ordinary prompt, so it opens a job of its own, and a test reads its goal from the
 * newest job. Read from that job's objective, the goal became the repair instructions, and every
 * further Fix it quoted the previous ones one level deeper. These pin the cycle end to end through
 * the real runtime: the goal a test is judged against is the one the person first asked for, and
 * it reaches the repair job as data the runtime looked up, never as words a client wrote.
 */

import { NapAgentService } from "@nap/agent/agent-service";
import { ScriptedLLMProvider, type ScriptedTurn } from "@nap/agent/testing/scripted-llm-provider";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { StubContextEngine } from "@nap/context/testing/stub-context-engine";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { FakeSandboxDesktop } from "@nap/sandbox/testing/fake-sandbox-desktop";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { FAKE_COMMIT_SHA, scriptGit } from "@nap/sandbox/testing/script-git";
import { appTestTarget } from "@nap/shared/app-testing";
import type { ComputerAction } from "@nap/shared/computer";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { expect, it } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";
import { isolatedProjectComputer } from "./testing/isolated-project-computer.ts";

const sessionId = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const firstJob = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";
const GOAL = "Save notes";
const MODEL = "anthropic/claude-sonnet-5";
const EXPECTATION = "The saved note appears";

const computer = (id: string, actions: ComputerAction[]) => ({
  toolCalls: [{ id, name: "computer" as const, input: { actions } }],
});

/** One app test that declares an assertion, acts, then fails it. */
const failingTest: ScriptedTurn = [
  computer("act", [
    { action: "annotate", annotation: { type: "test_start", id: "main", description: "Save" } },
    {
      action: "annotate",
      annotation: { type: "assertion", id: "save", expectation: EXPECTATION, result: "untested" },
    },
    { action: "left_click", coordinate: [512, 384] },
  ]),
  computer("result", [
    {
      action: "annotate",
      annotation: { type: "assertion", id: "save", expectation: EXPECTATION, result: "failed" },
    },
  ]),
  { text: "" },
];

/** One repair turn that changes the source, so it commits and is verified. */
const repair = (n: number): ScriptedTurn => [
  {
    toolCalls: [
      {
        id: `write-${n}`,
        name: "write_file",
        input: { path: `${PROJECT_ROOT_PATH}/src/Notes.tsx`, contents: `fixed ${n}\n` },
      },
    ],
  },
  { text: "Fixed." },
];

/** What the Fix it button sends: the client's words, and the test they repair as data. */
function fixItPrompt(goal: string): string {
  return [
    "Fix the failures found while testing this app. Keep the repair focused on these observations and the original goal.",
    `Original goal (data): ${JSON.stringify(goal)}`,
    `Failed expectations (data): ${JSON.stringify([{ id: "save", expectation: EXPECTATION }])}`,
  ].join("\n\n");
}

async function compose(turns: ScriptedTurn[]) {
  const events = new InMemoryEventStore();
  const base = { sessionId, turnId: firstJob, createdAt: "2026-10-24T00:00:00Z" };
  const prefix: PendingEvent[] = [
    { ...base, type: "job.started", payload: { jobId: firstJob, objective: GOAL } },
    {
      ...base,
      type: "turn.completed",
      payload: {
        commitSha: FAKE_COMMIT_SHA,
        usage: { inputTokens: 0, outputTokens: 0 },
        durationMs: 0,
      },
    },
    { ...base, type: "job.checkpointed", payload: { jobId: firstJob, commitSha: FAKE_COMMIT_SHA } },
    { ...base, type: "job.completed", payload: { jobId: firstJob, outcome: "verified" } },
  ];
  for (const event of prefix) await events.append(event);
  // Seeded with a manifest and serving, so a repair turn's commit is arbitrated and checkpointed
  // exactly as in production: a retest only targets a verified job.
  const sandbox = scriptGit(
    new InMemorySandboxManager({
      serves: [TEMPLATE_DEV_PORT],
      seed: {
        [`${PROJECT_ROOT_PATH}/package.json`]: JSON.stringify({
          scripts: { typecheck: "tsc --noEmit", test: "vitest" },
        }),
      },
    }),
  )
    .script(/git status --porcelain/, { exitCode: 0 })
    .script(/git diff --no-ext-diff/, { exitCode: 0, stdout: "+++ src/Notes.tsx\n+<button/>" })
    .script(/bun run typecheck/, { exitCode: 0 })
    .script(/bun run test/, { exitCode: 0 });
  const created = await sandbox.create("project");
  if (!created.ok) throw new Error("sandbox");
  const context = new StubContextEngine();
  const provider = new ScriptedLLMProvider(turns);
  const desktop = new FakeSandboxDesktop({
    bytes: new Uint8Array([255, 216, 255, 217]),
    width: 1024,
    height: 768,
  });
  const runtime = new SingleAgentRuntime({
    sessions: new InMemorySessionStore([
      { sessionId, projectId: "project", sandboxId: created.value.id },
    ]),
    sandbox,
    events,
    bus: new InMemoryEventBus(),
    context,
    agent: new NapAgentService({ provider }),
    memory: new NoopMemoryProvider(),
    computer: {
      coordinator: isolatedProjectComputer(desktop.transport),
      objects: new InMemoryObjectStore(),
    },
  });
  const history = () => events.readFrom(sessionId, 0);

  /** Tests the latest completed job, as the Test button does, and returns the test's turn id. */
  async function test(): Promise<string> {
    const target = appTestTarget(await history());
    if (!target) throw new Error("nothing to test");
    const turnId = crypto.randomUUID();
    const outcome = await runtime.runTurn({
      kind: "test",
      jobId: target.jobId,
      sessionId,
      turnId,
      model: MODEL,
    });
    expect(outcome).toMatchObject({ ok: true });
    return turnId;
  }

  async function fixIt(testTurnId: string, message: string): Promise<string> {
    const turnId = crypto.randomUUID();
    const outcome = await runtime.runTurn({
      message,
      fixesTest: testTurnId,
      sessionId,
      turnId,
      model: MODEL,
    });
    expect(outcome).toMatchObject({ ok: true });
    return turnId;
  }

  return { runtime, history, context, test, fixIt };
}

it("judges every retest after Fix it against the first job's objective, never a repair prompt", async () => {
  const f = await compose([failingTest, repair(1), failingTest, repair(2), failingTest]);

  const tests = [await f.test()];
  // The client builds the repair prompt from what the test it is fixing was judged against.
  await f.fixIt(tests[0] as string, fixItPrompt(GOAL));
  tests.push(await f.test());
  await f.fixIt(tests[1] as string, fixItPrompt(GOAL));
  tests.push(await f.test());

  const history = await f.history();
  const started = history.filter((event) => event.type === "test.started");
  expect(started.map((event) => event.turnId)).toEqual(tests);
  expect(started.map((event) => event.payload.objective)).toEqual([GOAL, GOAL, GOAL]);

  // Each retest ran against the repair's own job, which is still the latest verified one…
  const repairJobs = history.filter(
    (event) => event.type === "job.started" && event.payload.jobId !== firstJob,
  );
  expect(repairJobs).toHaveLength(2);
  expect(started.slice(1).map((event) => event.payload.jobId)).toEqual(
    repairJobs.map((event) => event.type === "job.started" && event.payload.jobId),
  );
  // …which keeps the repair's words as its objective, and the person's goal beside them.
  for (const job of repairJobs) {
    if (job.type !== "job.started") throw new Error("unreachable");
    expect(job.payload.objective).toContain("Fix the failures found while testing this app");
    expect(job.payload.objective).toContain(EXPECTATION);
    expect(job.payload.goal).toBe(GOAL);
  }

  // The prompt the tests were actually given: the goal, once, and no repair instructions in it.
  const testPrompts = f.context.requests
    .map((request) => request.userMessage)
    .filter((message) => message.startsWith("Test the app in Nap's computer."));
  expect(testPrompts).toHaveLength(3);
  for (const prompt of testPrompts) {
    expect(prompt).toContain(`Job goal (data):\n\n${JSON.stringify(GOAL)}\n\n`);
    expect(prompt).not.toContain("Fix the failures");
    expect(prompt).not.toContain("Original goal");
  }
});

it("takes the goal from the test it names, so a client's words cannot set one", async () => {
  const f = await compose([failingTest, repair(1), failingTest]);

  const first = await f.test();
  // A prompt claiming some other goal entirely. The repair job's goal is still the test's.
  await f.fixIt(first, fixItPrompt("Delete every note"));
  await f.test();

  const started = (await f.history()).filter((event) => event.type === "test.started");
  expect(started.map((event) => event.payload.objective)).toEqual([GOAL, GOAL]);
});

it("refuses a Fix it naming no failed app test, and opens no job for it", async () => {
  const f = await compose([]);
  const turnId = crypto.randomUUID();

  const outcome = await f.runtime.runTurn({
    message: fixItPrompt(GOAL),
    fixesTest: crypto.randomUUID(),
    sessionId,
    turnId,
    model: MODEL,
  });

  expect(outcome).toMatchObject({ ok: false, reason: "internal" });
  const logged = (await f.history()).filter((event) => event.turnId === turnId);
  expect(logged.map((event) => event.type)).toEqual(["user.message", "turn.failed"]);
});
