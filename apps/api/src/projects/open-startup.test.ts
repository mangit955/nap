import { completedTurn, ScriptedAgent } from "@nap/agent/testing/scripted-agent";
import { GatedPageCapture } from "@nap/capture/testing/gated-page-capture";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { StubContextEngine } from "@nap/context/testing/stub-context-engine";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemoryProjectSandboxStore } from "@nap/db/testing/in-memory-project-sandbox-store";
import { FAKE_OWNER, InMemoryProjectStore } from "@nap/db/testing/in-memory-project-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemoryTurnQueue } from "@nap/db/testing/in-memory-turn-queue";
import { SingleAgentRuntime } from "@nap/runtime/single-agent-runtime";
import { withoutAnnouncement } from "@nap/runtime/testing/preview-announcement";
import { ThumbnailLane } from "@nap/runtime/thumbnail-lane";
import { startTurnWorker } from "@nap/runtime/turn-worker";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import {
  FAKE_BUNDLE,
  FAKE_COMMIT_SHA,
  RESTORE_COMMAND,
  restored,
  scriptGit,
} from "@nap/sandbox/testing/script-git";
import type { EventStore } from "@nap/shared/ports/event-store";
import type { RepositorySource, RepositoryWorkspace } from "@nap/shared/ports/repository-workspace";
import type { SandboxError } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { TurnRegistry } from "../turns/registry.ts";

const SESSION = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const PROJECT = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const MODEL = "openai/gpt-oss-20b:free";
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Real admission, leasing, restore and orchestration; only external services are fakes. */
async function system(options: { restored?: boolean; repositoryPort?: number | null } = {}) {
  const sandbox = scriptGit(
    new InMemorySandboxManager({
      serves: [TEMPLATE_DEV_PORT, 3000],
      seed: { "/home/user/app/package.json": '{"scripts":{}}' },
    }),
  );
  // Equal dependency keys take the current fast restore path, with no install.
  sandbox.script(RESTORE_COMMAND, restored("1".repeat(64)));
  sandbox.script(/git clean -fdx|pkill -f|status --porcelain|nohup sh/, { exitCode: 0 });
  const sessions = new InMemorySessionStore([{ sessionId: SESSION, projectId: PROJECT }]);
  const projects = new InMemoryProjectStore([
    {
      projectId: PROJECT,
      name: "Todo app",
      status: "ready",
      sandboxId: null,
      updatedAt: "2026-08-09T11:00:00.000Z",
      sessionIds: [SESSION],
    },
  ]);
  const queue = new InMemoryTurnQueue();
  const events = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const objects = new InMemoryObjectStore();
  const snapshots = new InMemorySnapshotStore();
  if (options.restored) {
    const key = `projects/${PROJECT}/saved.bundle`;
    await objects.put(key, FAKE_BUNDLE);
    await snapshots.record({ projectId: PROJECT, key, gitSha: FAKE_COMMIT_SHA });
  }
  const imported = vi.fn<RepositorySource["initialBundle"]>(async () => ({
    ok: true,
    value: FAKE_BUNDLE,
  }));
  const repository: RepositoryWorkspace | undefined =
    options.repositoryPort === undefined
      ? undefined
      : {
          source: async () => ({
            ok: true,
            value: {
              setupCommand: null,
              devCommand: options.repositoryPort === null ? null : "bun run dev",
              previewPort: options.repositoryPort ?? null,
              initialBundle: imported,
            },
          }),
          prepareJob: async () => ({ ok: true, value: undefined }),
          finishJob: async () => ({ ok: true, value: undefined }),
        };
  const preview = gate<Result<string, SandboxError>>();
  const wait = vi.spyOn(sandbox, "waitForPreview").mockImplementation(() => preview.promise);
  const capture = new GatedPageCapture();
  const lane = new ThumbnailLane({
    sandbox,
    capture,
    objects,
    concurrency: 1,
    maxQueued: 2,
    stopGraceMs: 0,
  });
  const context = new StubContextEngine();
  const agent = new ScriptedAgent(() => completedTurn(null));
  const outsideLease: string[] = [];
  // Assumes every event's turnId is a request's id. A continuation's repairs get turn ids of their
  // own, so a test that continues an open job would need this to learn them.
  const store: EventStore = {
    append: async (event, retry) => {
      if (queue.stateOf(event.turnId) !== "leased") outsideLease.push(event.type);
      return events.append(event, retry);
    },
    readFrom: (sessionId, afterSeq) => events.readFrom(sessionId, afterSeq),
  };
  const runtime = new SingleAgentRuntime({
    sessions,
    sandbox,
    context,
    agent,
    events: store,
    bus,
    objects,
    snapshots,
    memory: new NoopMemoryProvider(),
    thumbnails: lane,
    previewTimeoutMs: 60_000,
    previewRecheckMs: 50,
    ...(repository === undefined ? {} : { repository }),
  });
  const worker = startTurnWorker({
    queue,
    runtime,
    concurrency: 2,
    pollIntervalMs: 2,
    renewIntervalMs: 5,
    // Bounds stop() at about a second, not ten minutes, if a turn is stuck on a gate cleanup does not release.
    drainTimeoutMs: 1_000,
    abortGraceMs: 100,
  });
  cleanup.push(async () => {
    preview.resolve({ ok: false, error: { code: "timeout", message: "test cleanup" } });
    capture.releaseAll();
    await worker.stop();
    await lane.stop();
    expect(outsideLease).toEqual([]);
  });
  const models = { allowedModels: [MODEL], freeModel: MODEL, defaultModel: MODEL };
  const app = createApp({
    logger: createLogger({ level: "silent" }, { write: () => {} }),
    authenticate: async () => ({ userId: FAKE_OWNER, isAnonymous: false }),
    stream: { store: events, bus, upgradeWebSocket: async () => new Response(null) },
    projects: {
      projects,
      projectSandboxes: new InMemoryProjectSandboxStore(),
      snapshots,
      objects,
      sandbox,
      createProject: async () => ({ projectId: PROJECT, sessionId: SESSION }),
      isBusy: (ids) => queue.anyLeased(ids),
      events: { events, bus },
      queue,
      models,
    },
    turns: { queue, registry: new TurnRegistry(), projects, sessions, ...models },
  });
  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const ready = async () => {
    const session = await sessions.get(SESSION);
    if (session?.sandboxId == null) throw new Error("sandbox was not acquired");
    const url = `https://${options.repositoryPort ?? TEMPLATE_DEV_PORT}-${session.sandboxId}.sandbox.invalid`;
    preview.resolve({ ok: true, value: url });
    return url;
  };
  return {
    sandbox,
    sessions,
    queue,
    events,
    context,
    agent,
    wait,
    preview,
    capture,
    snapshots,
    imported,
    ready,
    post,
    log: () => events.readFrom(SESSION, 0),
  };
}

describe.each([false, true])("opening a project, restored=%s", (restored) => {
  // This pins a known cost, not a goal. The open's announcement must be written under its own
  // lease, so a message sent meanwhile waits for the dev server, up to the probe timeout. Removing
  // the wait needs the running open to learn a request is queued and hand the announcement over,
  // which nothing does yet. See docs/GOTCHAS.md, "Sandbox and storage".
  it.each(["turns", "steers"])(
    "still queues an immediate message through /%s until the open's announcement settles",
    async (route) => {
      const f = await system({ restored });
      expect((await f.post(`/projects/${PROJECT}/open`)).status).toBe(202);
      await vi.waitFor(() => expect(f.wait).toHaveBeenCalled());
      const response = await f.post(`/sessions/${SESSION}/${route}`, {
        id: crypto.randomUUID(),
        message: "make it red",
      });
      expect(response.status).toBe(202);
      if (route === "steers") expect(await response.json()).toMatchObject({ as: "turn" });
      const [resume, message] = f.queue.enqueued;
      expect(f.queue.stateOf(resume!.id)).toBe("leased");
      expect(f.queue.stateOf(message!.id)).toBe("queued");
      expect(f.context.requests).toEqual([]);
      expect(f.agent.calls).toBe(0);
      expect(await f.log()).toEqual([]);

      await f.ready();
      await vi.waitFor(() => expect(f.queue.inFlight).toBe(0));
      expect(f.agent.calls).toBe(1);
      const log = await f.log();
      expect(log.filter((event) => event.type === "preview.ready")).toEqual([
        expect.objectContaining({ turnId: resume!.id }),
      ]);
      expect(log.find((event) => event.type === "user.message")?.turnId).toBe(message!.id);
    },
  );

  it("announces an open with no message under its lease, and releases it while capture is gated", async () => {
    const f = await system({ restored });
    expect((await f.post(`/projects/${PROJECT}/open`)).status).toBe(202);
    await vi.waitFor(() => expect(f.wait).toHaveBeenCalled());
    expect(await f.log()).toEqual([]);
    expect(f.context.requests).toEqual([]);
    const resume = f.queue.enqueued[0];
    expect(resume?.kind).toBe("resume");
    const url = await f.ready();
    await vi.waitFor(() => expect(f.queue.inFlight).toBe(0));
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));
    expect(await f.log()).toEqual([
      expect.objectContaining({
        type: "preview.ready",
        turnId: resume!.id,
        sessionId: SESSION,
        payload: { url, port: TEMPLATE_DEV_PORT },
      }),
    ]);
    expect(f.agent.calls).toBe(0);
    const session = await f.sessions.get(SESSION);
    expect(f.sandbox.commands(session!.sandboxId!).some((cmd) => cmd.includes("bun install"))).toBe(
      false,
    );
  });
});

it.each([
  { restored: false },
  { restored: true },
  { restored: false, repositoryPort: 3000 },
  { restored: true, repositoryPort: 3000 },
])("starts context and the model before preview readiness: %j", async (options) => {
  const f = await system(options);
  const port = options.repositoryPort ?? TEMPLATE_DEV_PORT;
  expect(
    (await f.post(`/sessions/${SESSION}/turns`, { message: "build a todo list" })).status,
  ).toBe(202);
  await vi.waitFor(() => expect(f.context.requests).toHaveLength(1));
  await vi.waitFor(() => expect(f.agent.calls).toBe(1));
  expect((await f.log()).some((e) => e.type === "preview.ready")).toBe(false);
  expect(f.wait).toHaveBeenCalledWith(expect.any(String), port, { timeoutMs: 60_000 });
  expect(f.queue.inFlight).toBe(1);
  const url = await f.ready();
  await vi.waitFor(() => expect(f.queue.inFlight).toBe(0));
  const log = await f.log();
  withoutAnnouncement(log);
  expect(log.find((e) => e.type === "preview.ready")?.payload).toEqual({ url, port });
  expect(f.imported).toHaveBeenCalledTimes(
    options.repositoryPort !== undefined && !options.restored ? 1 : 0,
  );
});

it.each([{ restored: false }, { restored: true }])(
  "neither probes nor announces an imported project with no preview port: %j",
  async (options) => {
    const f = await system({ ...options, repositoryPort: null });
    expect(
      (await f.post(`/sessions/${SESSION}/turns`, { message: "build a todo list" })).status,
    ).toBe(202);
    await vi.waitFor(() => expect(f.queue.inFlight).toBe(0));
    expect(f.context.requests).toHaveLength(1);
    expect(f.agent.calls).toBe(1);
    expect(f.wait).not.toHaveBeenCalled();
    expect((await f.log()).some((e) => e.type === "preview.ready")).toBe(false);
    expect(f.imported).toHaveBeenCalledTimes(options.restored ? 0 : 1);
  },
);

it("discards a cancelled resume's late readiness after a replacement sandbox starts", async () => {
  const f = await system({ restored: true });
  expect((await f.post(`/projects/${PROJECT}/open`)).status).toBe(202);
  await vi.waitFor(() => expect(f.wait).toHaveBeenCalled());
  const resume = f.queue.enqueued[0]!;
  const oldSandbox = (await f.sessions.get(SESSION))!.sandboxId!;
  await f.queue.requestCancel(SESSION);
  // The preview remains gated. Cancellation must settle the resume without waiting for it.
  await vi.waitFor(() => expect(f.queue.inFlight).toBe(0));
  expect(f.queue.stateOf(resume.id)).toBe("done");
  expect(await f.log()).toEqual([]);

  await f.sandbox.destroy(oldSandbox);
  const next = gate<Result<string, SandboxError>>();
  cleanup.unshift(async () => {
    next.resolve({ ok: false, error: { code: "timeout", message: "cleanup" } });
  });
  f.wait.mockImplementation(() => next.promise);
  expect((await f.post(`/sessions/${SESSION}/turns`, { message: "carry on" })).status).toBe(202);
  await vi.waitFor(() => expect(f.agent.calls).toBe(1));
  const replacement = (await f.sessions.get(SESSION))!.sandboxId!;
  expect(replacement).not.toBe(oldSandbox);
  // A probe left behind by cancellation cannot announce under either the old or the new lease.
  f.preview.resolve({ ok: true, value: `https://${oldSandbox}.sandbox.invalid` });
  await f.preview.promise;
  expect((await f.log()).filter((event) => event.type === "preview.ready")).toEqual([]);
  const url = `https://${TEMPLATE_DEV_PORT}-${replacement}.sandbox.invalid`;
  next.resolve({ ok: true, value: url });
  await vi.waitFor(() => expect(f.queue.inFlight).toBe(0));
  const message = f.queue.enqueued[1]!;
  expect((await f.log()).filter((event) => event.type === "preview.ready")).toEqual([
    expect.objectContaining({ turnId: message.id, payload: { url, port: TEMPLATE_DEV_PORT } }),
  ]);

  const probes = f.wait.mock.calls.length;
  expect((await f.post(`/sessions/${SESSION}/turns`, { message: "more" })).status).toBe(202);
  await vi.waitFor(() => expect(f.queue.inFlight).toBe(0));
  expect(f.wait).toHaveBeenCalledTimes(probes);
  expect((await f.log()).filter((event) => event.type === "preview.ready")).toHaveLength(1);
});

it.each(["timeout", "failure", "rejection"])(
  "releases a resume after preview %s and announces on the next message",
  async (failure) => {
    const f = await system();
    expect((await f.post(`/projects/${PROJECT}/open`)).status).toBe(202);
    await vi.waitFor(() => expect(f.wait).toHaveBeenCalled());
    if (failure === "timeout")
      f.preview.resolve({ ok: false, error: { code: "timeout", message: "not serving" } });
    if (failure === "failure")
      f.preview.resolve({
        ok: false,
        error: { code: "unavailable", message: "provider unavailable" },
      });
    if (failure === "rejection") f.preview.reject(new Error("preview probe failed"));
    await vi.waitFor(() => expect(f.queue.inFlight).toBe(0));
    expect(await f.log()).toEqual([]);
    f.wait.mockResolvedValue({ ok: true, value: "https://serving.sandbox.invalid" });
    expect((await f.post(`/sessions/${SESSION}/turns`, { message: "try again" })).status).toBe(202);
    await vi.waitFor(() => expect(f.queue.inFlight).toBe(0));
    const message = f.queue.enqueued[1]!;
    expect((await f.log()).filter((event) => event.type === "preview.ready")).toEqual([
      expect.objectContaining({ turnId: message.id }),
    ]);
    // An already-running, unannounced preview gets the bounded recheck, not another cold wait.
    expect(f.wait).toHaveBeenLastCalledWith(expect.any(String), TEMPLATE_DEV_PORT, {
      timeoutMs: 50,
    });
  },
);
