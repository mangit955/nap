import { NapAgentService } from "@nap/agent/agent-service";
import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { StubContextEngine } from "@nap/context/testing/stub-context-engine";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { FakeSandboxDesktop } from "@nap/sandbox/testing/fake-sandbox-desktop";
import { FakeSandboxRecordings } from "@nap/sandbox/testing/fake-sandbox-recordings";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { FAKE_COMMIT_SHA, scriptGit } from "@nap/sandbox/testing/script-git";
import type { ComputerAction } from "@nap/shared/computer";
import type { ContextEngine } from "@nap/shared/ports/context-engine";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type { DesktopAction } from "@nap/shared/ports/sandbox-desktop";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { expect, it, vi } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";

const sessionId = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const jobId = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";
const annotation = {
  type: "assertion",
  id: "save",
  expectation: "The saved note appears",
  result: "untested",
} as const;
async function fixture(
  result: "passed" | "failed" = "passed",
  compact = false,
  record = false,
  inputAction: DesktopAction = { action: "left_click", coordinate: [512, 384] },
  cold = false,
) {
  const events = new InMemoryEventStore();
  const base = { sessionId, turnId: jobId, createdAt: "2026-10-24T00:00:00Z" };
  const prefix: PendingEvent[] = [
    { ...base, type: "job.started", payload: { jobId, objective: "Save notes" } },
    {
      ...base,
      type: "turn.completed",
      payload: {
        commitSha: FAKE_COMMIT_SHA,
        usage: { inputTokens: 0, outputTokens: 0 },
        durationMs: 0,
      },
    },
    { ...base, type: "job.checkpointed", payload: { jobId, commitSha: FAKE_COMMIT_SHA } },
    { ...base, type: "job.completed", payload: { jobId, outcome: "verified" } },
  ];
  for (const event of prefix) await events.append(event);
  const sandbox = scriptGit(new InMemorySandboxManager())
    .script(/git status --porcelain/, { exitCode: 0 })
    .script(/git diff --no-ext-diff/, {
      exitCode: 0,
      stdout: "+++ src/Notes.tsx\n+<button>Save</button>",
    });
  const created = await sandbox.create("project");
  if (!created.ok) throw new Error("sandbox");
  if (compact)
    await events.append({
      ...base,
      type: "agent.message",
      payload: { text: "Earlier completed work" },
    });
  const context = new StubContextEngine();
  const realContext = new NapContextEngine();
  const assembly: ContextEngine = {
    async build(request) {
      const recorded = await context.build(request);
      if (!compact) return recorded;
      const built = await realContext.build(request);
      return { ...built, needsCompaction: context.requests.length === 1 };
    },
  };
  const batch = (id: string, actions: ComputerAction[]) => ({
    toolCalls: [{ id, name: "computer", input: { actions } }],
  });
  const provider = new ScriptedLLMProvider([
    [
      ...(compact ? [{ text: "A compact session summary" }] : []),
      batch("act", [
        {
          action: "annotate",
          annotation: { type: "test_start", id: "main", description: "Save a note" },
        },
        { action: "annotate", annotation },
        inputAction,
      ]),
      batch("result", [{ action: "annotate", annotation: { ...annotation, result } }]),
      { text: "" },
    ],
  ]);
  const desktop = new FakeSandboxDesktop({
    bytes: new Uint8Array([255, 216, 255, 217]),
    width: 1024,
    height: 768,
  });
  const objects = new InMemoryObjectStore();
  const recordings = new FakeSandboxRecordings({
    bytes: new Uint8Array([1, 2, 3]),
    durationMs: 1000,
    width: 1024,
    height: 768,
  });
  const sessions = new InMemorySessionStore([
    { sessionId, projectId: "project", sandboxId: cold ? null : created.value.id },
  ]);
  const runtime = new SingleAgentRuntime({
    sessions,
    sandbox,
    events,
    bus: new InMemoryEventBus(),
    context: assembly,
    agent: new NapAgentService({ provider }),
    memory: new NoopMemoryProvider(),
    computer: { desktop, objects, ...(record ? { recordings } : {}) },
  });
  const request = {
    kind: "test" as const,
    jobId,
    sessionId,
    turnId: crypto.randomUUID(),
    model: "anthropic/claude-sonnet-5",
  };
  return {
    runtime,
    sessions,
    request,
    events,
    sandbox,
    sandboxId: created.value.id,
    context,
    provider,
    desktop,
    recordings,
    objects,
  };
}
it.each(["passed", "failed"] as const)(
  "runs a %s app test as a source-grounded turn without a commit or automatic repair",
  async (result) => {
    const f = await fixture(result);
    expect((await f.runtime.runTurn(f.request)).ok).toBe(true);
    const events = await f.events.readFrom(sessionId, 4);
    expect(
      events.filter((e) => e.type === "job.started" || e.type === "verification.started"),
    ).toEqual([]);
    expect(events.find((e) => e.type === "turn.started")?.payload.source).toBe("test");
    expect(events.find((e) => e.type === "test.completed")?.payload).toEqual({
      jobId,
      status: "completed",
      counts: {
        passed: result === "passed" ? 1 : 0,
        failed: result === "failed" ? 1 : 0,
        untested: 0,
      },
    });
    expect(f.provider.requests).toHaveLength(3);
    expect(events.some((event) => event.type === "user.message")).toBe(false);
    expect(f.context.requests[0]?.userMessage).toContain("src/Notes.tsx");
    expect(f.sandbox.commands(f.sandboxId).some((c) => /git .*commit -m/.test(c))).toBe(false);
    const types = events.map((e) => e.type);
    expect(types.indexOf("test.started")).toBeLessThan(types.indexOf("turn.started"));
    expect(types.at(-1)).toBe("test.completed");
  },
);
it("rejects stale job approval, changed HEAD, dirty source and a text-only model without calling the model", async () => {
  for (const mode of ["job", "head", "dirty", "model"] as const) {
    const f = await fixture();
    if (mode === "head")
      f.sandbox.script(/git rev-parse HEAD/, { exitCode: 0, stdout: "different" });
    if (mode === "dirty")
      f.sandbox.script(/git status --porcelain/, { exitCode: 0, stdout: " M src/App.tsx" });
    const outcome = await f.runtime.runTurn({
      ...f.request,
      ...(mode === "job" ? { jobId: crypto.randomUUID() } : {}),
      ...(mode === "model" ? { model: "openai/gpt-oss-20b:free" } : {}),
    });
    expect(outcome.ok, mode).toBe(false);
    expect(f.provider.requests, mode).toHaveLength(0);
  }
});

it("ends a cancelled app test as interrupted with untested assertions and no repair", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const act = f.desktop.act.bind(f.desktop);
  vi.spyOn(f.desktop, "act").mockImplementation(async (...args) => {
    const result = await act(...args);
    controller.abort();
    return result;
  });
  const outcome = await f.runtime.runTurn({ ...f.request, signal: controller.signal });
  expect(outcome).toMatchObject({ ok: false, reason: "cancelled" });
  const log = await f.events.readFrom(sessionId, 4);
  expect(log.find((event) => event.type === "test.completed")?.payload).toMatchObject({
    status: "interrupted",
    counts: { passed: 0, failed: 0, untested: 1 },
  });
  expect(f.provider.requests).toHaveLength(1);
  expect(log.some((event) => event.type === "job.started")).toBe(false);
});

it("retains the active generated test prompt through real context compaction without protecting it in future history", async () => {
  const f = await fixture("passed", true);
  expect((await f.runtime.runTurn(f.request)).ok).toBe(true);
  expect(f.context.requests).toHaveLength(2);
  expect(f.context.requests[1]?.continuation).toBe(false);
  expect(JSON.stringify(f.provider.requests[1]?.messages)).toContain("src/Notes.tsx");
  expect(
    (await f.events.readFrom(sessionId, 0)).some((event) => event.type === "user.message"),
  ).toBe(false);
});

it("captures a test turn after its durable start and uploads video before test completion", async () => {
  const f = await fixture("passed", false, true);
  const begin = f.recordings.begin.bind(f.recordings);
  vi.spyOn(f.recordings, "begin").mockImplementation(async (options) => {
    expect(
      (await f.events.readFrom(sessionId, 0)).some(
        (event) => event.type === "test.started" && event.turnId === f.request.turnId,
      ),
    ).toBe(true);
    return begin(options);
  });
  vi.spyOn(f.recordings, "timestamp").mockResolvedValue({ ok: true, value: 375 });
  expect((await f.runtime.runTurn(f.request)).ok).toBe(true);
  const events = await f.events.readFrom(sessionId, 4);
  const available = events.find(
    (event) => event.type === "test.recording" && event.payload.recording.state === "available",
  );
  expect(available).toMatchObject({
    payload: {
      recording: {
        state: "available",
        durationMs: 1000,
        width: 1024,
        height: 768,
        interrupted: false,
      },
    },
  });
  expect(events.filter((event) => event.type === "test.annotation")).toHaveLength(3);
  expect(
    events
      .filter((event) => event.type === "test.annotation")
      .every((event) => event.payload.timeMs === 375),
  ).toBe(true);
  expect(events.at(-1)?.type).toBe("test.completed");
  expect(
    (await f.objects.get(`computer/project/${sessionId}/${f.request.turnId}/recording.mp4`)).ok,
  ).toBe(true);
  expect(f.recordings.calls.at(-1)?.operation).toBe("discard");
});

it("waits for a newly created workspace preview before starting the desktop capture", async () => {
  const f = await fixture(
    "passed",
    false,
    true,
    { action: "left_click", coordinate: [512, 384] },
    true,
  );
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wait = vi.spyOn(f.sandbox, "waitForPreview").mockImplementation(async () => {
    await ready;
    return { ok: true, value: "https://preview.test" };
  });
  const start = vi.spyOn(f.desktop, "start");
  const running = f.runtime.runTurn(f.request);
  await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
  expect(start).not.toHaveBeenCalled();
  release?.();
  expect((await running).ok).toBe(true);
  expect(start).toHaveBeenCalled();
});
it("finalizes an interrupted recording after cancellation without an aborted cleanup signal", async () => {
  const f = await fixture("passed", false, true);
  const controller = new AbortController();
  const act = f.desktop.act.bind(f.desktop);
  vi.spyOn(f.desktop, "act").mockImplementation(async (...args) => {
    const result = await act(...args);
    controller.abort();
    return result;
  });
  expect(await f.runtime.runTurn({ ...f.request, signal: controller.signal })).toMatchObject({
    ok: false,
    reason: "cancelled",
  });
  const events = await f.events.readFrom(sessionId, 4);
  expect(events.findLast((event) => event.type === "test.recording")).toMatchObject({
    payload: { recording: { state: "available", interrupted: true } },
  });
  expect(events.at(-1)).toMatchObject({
    type: "test.completed",
    payload: { status: "interrupted" },
  });
  expect(f.recordings.calls.filter((call) => call.operation === "finish")).toHaveLength(1);
});

it("releases held pointer input after a computer turn with a fresh cleanup signal", async () => {
  const f = await fixture("passed", false, false, { action: "left_mouse_down" });
  await f.runtime.runTurn(f.request);
  expect(f.desktop.actions.at(-1)?.action).toEqual({ action: "left_mouse_up" });
});
it("does not send cleanup input after losing the session lease", async () => {
  const { TurnAbortError } = await import("@nap/shared/turn-abort");
  const f = await fixture();
  const controller = new AbortController();
  const act = f.desktop.act.bind(f.desktop);
  vi.spyOn(f.desktop, "act").mockImplementation(async (...args) => {
    const result = await act(...args);
    controller.abort(new TurnAbortError("lease_lost"));
    return result;
  });
  await f.runtime.runTurn({ ...f.request, signal: controller.signal });
  expect(f.desktop.actions.at(-1)?.action.action).toBe("left_click");
});
