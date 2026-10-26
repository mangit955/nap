import { NapAgentService } from "@nap/agent/agent-service";
import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { type AppTestTask, runAppTest } from "@nap/bench/app-test";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { SingleAgentRuntime } from "@nap/runtime/single-agent-runtime";
import { isolatedProjectComputer } from "@nap/runtime/testing/isolated-project-computer";
import { FakeSandboxDesktop } from "@nap/sandbox/testing/fake-sandbox-desktop";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { ComputerAction } from "@nap/shared/computer";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { ContextEngine } from "@nap/shared/ports/context-engine";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import { prepareAppTestFixture } from "../src/app-test-fixture.ts";

/** Always reports passed, independently of the variant. It cannot detect any planted bug. */
export async function runScriptedAppTest(
  task: AppTestTask,
  overrides: {
    provider?: ScriptedLLMProvider;
    desktop?: FakeSandboxDesktop;
  } = {},
) {
  const fixture = prepareAppTestFixture(task);
  try {
    const sessionId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const events = new InMemoryEventStore();
    const prefix = { sessionId, turnId: jobId, createdAt: "2026-10-24T00:00:00Z" };
    // Harness bootstrap, with real syntax checks above. No model is allowed to repair the specimen.
    const seeded: PendingEvent[] = [
      { ...prefix, type: "job.started", payload: { jobId, objective: task.objective } },
      {
        ...prefix,
        type: "turn.completed",
        payload: {
          commitSha: fixture.commitSha,
          usage: { inputTokens: 0, outputTokens: 0 },
          durationMs: 0,
        },
      },
      { ...prefix, type: "verification.started", payload: { jobId } },
      { ...prefix, type: "verification.completed", payload: { jobId, checks: fixture.checks } },
      { ...prefix, type: "job.checkpointed", payload: { jobId, commitSha: fixture.commitSha } },
      { ...prefix, type: "job.completed", payload: { jobId, outcome: "verified" } },
    ];
    for (const event of seeded) await events.append(event);
    const git = (args: string[]) => ({
      exitCode: 0,
      stdout: fixture.git(args),
    });
    const sandbox = new InMemorySandboxManager({
      seed: Object.fromEntries(
        Object.entries(fixture.files).map(([path, contents]) => [
          `${PROJECT_ROOT_PATH}/${path}`,
          contents,
        ]),
      ),
    })
      .script(/git rev-parse HEAD/, () => git(["rev-parse", "HEAD"]))
      .script(/git status --porcelain/, () => git(["status", "--porcelain"]))
      .script(/git diff --no-ext-diff/, (command) => {
        if (!command.includes(`${fixture.commitSha}^`) || !command.includes(fixture.commitSha))
          throw new Error("Unexpected source range.");
        return git([
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          `${fixture.commitSha}^`,
          fixture.commitSha,
          "--",
        ]);
      });
    const created = await sandbox.create(crypto.randomUUID());
    if (!created.ok) throw new Error(created.error.message);
    const sandboxId = created.value.id;
    const sessions = new InMemorySessionStore([
      { sessionId, projectId: created.value.projectId, sandboxId },
    ]);
    const bytes = new Map<string, Uint8Array>();
    const objects: ObjectStore = {
      async put(key, value) {
        bytes.set(key, value.slice());
        return { ok: true, value: undefined };
      },
      async get(key) {
        const value = bytes.get(key);
        return value
          ? { ok: true, value: value.slice() }
          : { ok: false, error: { code: "not_found", message: "No such fixture object." } };
      },
      async delete(key) {
        bytes.delete(key);
        return { ok: true, value: undefined };
      },
    };
    const annotation = {
      type: "assertion",
      id: task.assertionId,
      expectation:
        task.fixture === "notes"
          ? "The saved note persists after reload"
          : "The total matches price times quantity",
    } as const;
    const batch = (id: string, actions: ComputerAction[]) => ({
      toolCalls: [{ id, name: "computer", input: { actions } }],
    });
    const provider =
      overrides.provider ??
      new ScriptedLLMProvider([
        [
          batch("input", [
            {
              action: "annotate",
              annotation: {
                type: "test_start",
                id: task.flowId,
                description: "Exercise the main app flow",
              },
            },
            { action: "annotate", annotation: { ...annotation, result: "untested" } },
            { action: "annotate", annotation: { type: "action", description: "Click the app" } },
            { action: "left_click", coordinate: [100, 100] },
          ]),
          batch("verdict", [
            { action: "annotate", annotation: { ...annotation, result: "passed" } },
          ]),
          {},
        ],
      ]);
    const desktop =
      overrides.desktop ??
      new FakeSandboxDesktop({
        bytes: new Uint8Array([255, 216, 255, 217]),
        width: 1024,
        height: 768,
      });
    let prompt = "";
    const engine = new NapContextEngine();
    const context: ContextEngine = {
      async build(request) {
        prompt = request.userMessage;
        return engine.build(request);
      },
    };
    const runtime = new SingleAgentRuntime({
      sessions,
      sandbox,
      events,
      bus: new InMemoryEventBus(),
      context,
      agent: new NapAgentService({ provider }),
      memory: new NoopMemoryProvider(),
      computer: { coordinator: isolatedProjectComputer(desktop.transport), objects },
    });
    const result = await runAppTest({
      task,
      runtime,
      events,
      sessionId,
      turnId,
      jobId,
      commitSha: fixture.commitSha,
      model: "anthropic/claude-sonnet-5",
    });
    fixture.verify();
    const source = await sandbox.readFile(sandboxId, `${PROJECT_ROOT_PATH}/src/app.js`);
    const sourceUnchanged = source.ok && source.value === fixture.files["src/app.js"];
    if (!sourceUnchanged) throw new Error("The test altered its source fixture.");
    for (const event of result.events) {
      if (event.type === "computer.screenshot" && !bytes.has(event.payload.key))
        throw new Error("Screenshot event has no stored bytes.");
    }
    const commands = sandbox.commands(sandboxId);
    await sandbox.destroy(sandboxId);
    return {
      ...result,
      task,
      mode: "scripted" as const,
      modelCapability: null,
      seedOrigin: "harness" as const,
      fixture: {
        commitSha: fixture.commitSha,
        baseSha: fixture.baseSha,
        diff: fixture.diff,
        checks: fixture.checks,
      },
      sourceUnchanged,
      prompt,
      commands,
    };
  } finally {
    fixture.dispose();
  }
}
