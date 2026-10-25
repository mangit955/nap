import { NapAgentService } from "@nap/agent/agent-service";
import { ScriptedLLMProvider, type ScriptedTurn } from "@nap/agent/testing/scripted-llm-provider";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { StubContextEngine } from "@nap/context/testing/stub-context-engine";
import { expectEventSequence } from "@nap/db/testing/event-assertions";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { DesktopRequestSchema } from "@nap/sandbox/desktop-protocol";
import { E2BSandboxDesktop } from "@nap/sandbox/e2b-sandbox-desktop";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { scriptGit } from "@nap/sandbox/testing/script-git";
import type { PageCapture } from "@nap/shared/ports/page-capture";
import type { RepositoryWorkspace } from "@nap/shared/ports/repository-workspace";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { expect, it, vi } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";
import { isolatedProjectComputer } from "./testing/isolated-project-computer.ts";

const sessionId = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const projectId = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

async function fixture(phase: "ordinary" | "repair", refusalAfterInput = false, closeOnly = false) {
  const sandbox = scriptGit(
    new InMemorySandboxManager({
      seed: {
        "/home/user/app/package.json": '{"scripts":{"typecheck":"tsc --noEmit"}}',
        "/home/user/app/src/App.tsx": "original\n",
        "/home/user/app/untracked.txt": "keep this source\n",
      },
      defaultExec: () => ({ exitCode: 0 }),
    }),
  );
  sandbox.script(/bun run typecheck/, { exitCode: phase === "repair" ? 1 : 0, stdout: "check" });
  const created = await sandbox.create(projectId);
  if (!created.ok) throw new Error(created.error.message);
  const sandboxId = created.value.id;
  sandbox.listen(sandboxId, 3000);
  await sandbox.writeFile(sandboxId, "/tmp/nap-repository-preview.json", '{"previewPort":3000}');
  const events = new InMemoryEventStore();
  const snapshots = new InMemorySnapshotStore();
  const objects = new InMemoryObjectStore();
  const capture = vi.fn<PageCapture["capture"]>(async () => ({
    ok: true,
    value: new Uint8Array([1]),
  }));
  const commandsAfterUnknown: string[] = [];
  let completionUnknown = false;
  let snapshotsAtUnknown = -1;
  let capturesAtUnknown = -1;
  const exec = sandbox.exec.bind(sandbox);
  vi.spyOn(sandbox, "exec").mockImplementation(async (...args) => {
    if (completionUnknown) commandsAfterUnknown.push(args[1]);
    return exec(...args);
  });
  const finishJob = vi.fn<RepositoryWorkspace["finishJob"]>(async () => {
    await sandbox.exec(sandboxId, "printf repository-finish");
    return { ok: true, value: undefined };
  });
  const transport = new InMemorySandboxManager();
  vi.spyOn(transport, "exec")
    .mockResolvedValueOnce({
      ok: true,
      value: {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ ok: true, value: { width: 1024, height: 768 } }),
      },
    })
    .mockImplementation(async (_id, command) => {
      if (closeOnly) {
        const encoded = command.match(/'([A-Za-z0-9+/=]+)'$/)?.[1];
        if (!encoded) throw new Error("Missing encoded driver request.");
        const request = DesktopRequestSchema.parse(
          JSON.parse(Buffer.from(encoded, "base64").toString()),
        );
        if (request.op === "act")
          return {
            ok: true,
            value: {
              exitCode: 0,
              stdout: JSON.stringify({ ok: true, value: { kind: "none" } }),
              stderr: "",
            },
          };
        if (request.op === "screenshot")
          return {
            ok: true,
            value: {
              exitCode: 0,
              stdout: JSON.stringify({
                ok: true,
                value: { width: 1024, height: 768, data: "/9j/2Q==" },
              }),
              stderr: "",
            },
          };
      }
      if (!completionUnknown) {
        snapshotsAtUnknown = snapshots.all().length;
        capturesAtUnknown = capture.mock.calls.length;
      }
      completionUnknown = true;
      return { ok: true, value: { exitCode: 0, stdout: "{truncated", stderr: "" } };
    });
  const failingTurn: ScriptedTurn = [
    {
      toolCalls: [
        {
          id: "uncertain-input",
          name: "computer",
          input: { actions: [{ action: "left_click", coordinate: [10, 20] }] },
        },
      ],
    },
    refusalAfterInput ? { refusal: true } : {},
  ];
  const firstTurn: ScriptedTurn = [
    {
      toolCalls: [
        {
          id: "initial-source",
          name: "write_file",
          input: { path: "/home/user/app/src/App.tsx", contents: "changed\n" },
        },
      ],
    },
    {},
  ];
  // The spare refusal lets the unfixed runtime exit through a valid terminal path if
  // it incorrectly begins another repair. Script exhaustion must not be the RED oracle.
  const provider = new ScriptedLLMProvider([
    ...(phase === "repair" ? [firstTurn] : []),
    failingTurn,
    [{ refusal: true }],
  ]);
  const runtime = new SingleAgentRuntime({
    sessions: new InMemorySessionStore([{ sessionId, projectId, sandboxId }]),
    sandbox,
    events,
    snapshots,
    objects,
    capture: { capture },
    bus: new InMemoryEventBus(),
    context: new StubContextEngine(),
    memory: new NoopMemoryProvider(),
    agent: new NapAgentService({ provider }),
    computer: {
      coordinator: isolatedProjectComputer(new E2BSandboxDesktop({ sandbox: transport })),
      objects,
    },
    repository: {
      source: async () => ({
        ok: true,
        value: {
          previewPort: 3000,
          setupCommand: null,
          devCommand: "bun run dev",
          initialBundle: async () => ({ ok: true, value: new Uint8Array() }),
        },
      }),
      prepareJob: async () => ({ ok: true, value: undefined }),
      finishJob,
    },
  });
  return {
    runtime,
    events,
    snapshots,
    capture,
    finishJob,
    sandbox,
    sandboxId,
    commandsAfterUnknown,
    observed: () => ({ completionUnknown, snapshotsAtUnknown, capturesAtUnknown }),
  };
}

it.each(["ordinary", "repair"] as const)(
  "stops all later sandbox work after unknown input completion in an %s attempt",
  async (phase) => {
    const f = await fixture(phase);
    await f.runtime.runTurn({
      sessionId,
      turnId: crypto.randomUUID(),
      message: "Update the app",
      model: "anthropic/claude-sonnet-5",
    });
    expect(f.observed().completionUnknown).toBe(true);
    const events = await f.events.readFrom(sessionId, 0);
    expectEventSequence(
      events.filter(
        (event) =>
          (event.type === "tool.call" || event.type === "tool.result") &&
          event.payload.toolCallId === "uncertain-input",
      ),
      ["tool.call", "tool.result"],
    );
    expect(
      events.find(
        (event) => event.type === "tool.result" && event.payload.toolCallId === "uncertain-input",
      ),
    ).toMatchObject({ payload: { ok: false } });
    expect(f.commandsAfterUnknown).toEqual([]);
    expect(f.finishJob).not.toHaveBeenCalled();
    expect(f.snapshots.all()).toHaveLength(f.observed().snapshotsAtUnknown);
    expect(f.capture).toHaveBeenCalledTimes(f.observed().capturesAtUnknown);
    expect(await f.sandbox.readFile(f.sandboxId, "/home/user/app/untracked.txt")).toEqual({
      ok: true,
      value: "keep this source\n",
    });
  },
);

it("does not run repository finish when the agent already exits after uncertain input", async () => {
  const f = await fixture("ordinary", true);
  await f.runtime.runTurn({
    sessionId,
    turnId: crypto.randomUUID(),
    message: "Update the app",
    model: "anthropic/claude-sonnet-5",
  });
  expect(f.observed().completionUnknown).toBe(true);
  expect(f.finishJob).not.toHaveBeenCalled();
  expect(f.commandsAfterUnknown).toEqual([]);
});

it("retains a durable completed turn but skips all later sandbox work when healthy scope close is unproved", async () => {
  const f = await fixture("ordinary", false, true);
  const outcome = await f.runtime.runTurn({
    sessionId,
    turnId: crypto.randomUUID(),
    message: "Update the app",
    model: "anthropic/claude-sonnet-5",
  });
  expect(outcome).toMatchObject({ ok: true, commitSha: expect.any(String) });
  expect(f.observed().completionUnknown).toBe(true);
  expect(f.commandsAfterUnknown).toEqual([]);
  expect(f.finishJob).not.toHaveBeenCalled();
  expect(f.snapshots.all()).toHaveLength(0);
  expect(f.capture).not.toHaveBeenCalled();
  const events = await f.events.readFrom(sessionId, 0);
  expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  expect(events.filter((event) => event.type === "turn.failed")).toEqual([]);
  expect(events.some((event) => event.type === "verification.started")).toBe(false);
});
