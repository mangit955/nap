import { completedTurn, ScriptedAgent } from "@nap/agent/testing/scripted-agent";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { StubContextEngine } from "@nap/context/testing/stub-context-engine";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { FakeSandboxDesktop } from "@nap/sandbox/testing/fake-sandbox-desktop";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { FAKE_COMMIT_SHA, scriptGit } from "@nap/sandbox/testing/script-git";
import { foldJobs } from "@nap/shared/job-state";
import type { RepositorySource, RepositoryWorkspace } from "@nap/shared/ports/repository-workspace";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { expect, it, vi } from "vitest";
import { acquireSandbox } from "./acquire-sandbox.ts";
import { openProject } from "./restore.ts";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";

const sessionId = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const projectId = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const source: RepositorySource = {
  setupCommand: null,
  devCommand: null,
  previewPort: null,
  initialBundle: async () => ({ ok: true, value: Buffer.from("bundle") }),
};

async function fixture() {
  const sandbox = scriptGit(
    new InMemorySandboxManager({
      seed: { "/home/user/app/package.json": '{"scripts":{"typecheck":"tsc --noEmit"}}' },
    }),
  );
  const created = await sandbox.create(projectId);
  if (!created.ok) throw new Error(created.error.message);
  sandbox.script(/bun run typecheck/, { exitCode: 0 });
  const sessions = new InMemorySessionStore([
    { sessionId, projectId, sandboxId: created.value.id },
  ]);
  const session = await sessions.get(sessionId);
  if (session === null) throw new Error("missing session");
  const events = new InMemoryEventStore();
  const objects = new InMemoryObjectStore();
  const snapshots = new InMemorySnapshotStore();
  const prepareJob = vi.fn<RepositoryWorkspace["prepareJob"]>(async () => ({
    ok: true,
    value: undefined,
  }));
  const finishJob = vi.fn<RepositoryWorkspace["finishJob"]>(async () => ({
    ok: true,
    value: undefined,
  }));
  const repository: RepositoryWorkspace = {
    source: vi.fn<RepositoryWorkspace["source"]>(async () => ({ ok: true, value: source })),
    prepareJob,
    finishJob,
  };
  const agent = new ScriptedAgent(() => completedTurn(FAKE_COMMIT_SHA), true);
  const context = new StubContextEngine();
  const runtime = new SingleAgentRuntime({
    sessions,
    sandbox,
    events,
    objects,
    snapshots,
    repository,
    agent,
    context,
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
    computer: {
      desktop: new FakeSandboxDesktop({
        bytes: new Uint8Array([255, 216, 255, 217]),
        width: 1024,
        height: 768,
      }),
      objects,
    },
  });
  const turnId = crypto.randomUUID();
  const run = (signal?: AbortSignal) =>
    runtime.runTurn({
      sessionId,
      turnId,
      message: "Fix this repo",
      model: "anthropic/claude-sonnet-5",
      ...(signal === undefined ? {} : { signal }),
    });
  return {
    sandbox,
    sessions,
    session,
    events,
    objects,
    snapshots,
    repository,
    prepareJob,
    finishJob,
    agent,
    runtime,
    turnId,
    run,
  };
}

it("checks repository authority before reusing an already running sandbox", async () => {
  const f = await fixture();
  f.repository.source = async () => ({
    ok: false,
    error: { code: "access_denied", message: "Repository access was removed." },
  });
  expect(await f.run()).toMatchObject({ ok: false, reason: "sandbox_unavailable" });
  expect(f.agent.calls).toBe(0);
  expect(f.prepareJob).not.toHaveBeenCalled();
  expect(f.finishJob).not.toHaveBeenCalled();
});

it.each([null, 3000])(
  "retains the running preview port %s after an environment edit and applies the edit on restore",
  async (previewPort) => {
    const sandbox = scriptGit(new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) }));
    const sessions = new InMemorySessionStore([{ sessionId, projectId, sandboxId: null }]);
    const objects = new InMemoryObjectStore();
    const snapshots = new InMemorySnapshotStore();
    const imported = vi.fn(source.initialBundle);
    let configured: RepositorySource = {
      ...source,
      initialBundle: imported,
      previewPort,
      devCommand: previewPort === null ? null : `bun run dev --port ${previewPort}`,
    };
    const options = {
      sandbox,
      sessions,
      restore: { objects, snapshots },
      ttlMs: 1000,
      repository: {
        source: async () => ({ ok: true as const, value: configured }),
        prepareJob: async () => ({ ok: true as const, value: undefined }),
        finishJob: async () => ({ ok: true as const, value: undefined }),
      },
    };
    const session = await sessions.get(sessionId);
    if (session === null) throw new Error("Missing session");
    const first = await acquireSandbox(options, session);
    expect(first).toMatchObject({
      ok: true,
      value: { created: true, repository: { previewPort } },
    });
    if (!first.ok) throw new Error(first.error.message);
    configured = { ...configured, previewPort: 4000, devCommand: "bun run dev --port 4000" };
    const running = { ...session, sandboxId: first.value.id };
    expect(await acquireSandbox(options, running)).toMatchObject({
      ok: true,
      value: { id: first.value.id, created: false, repository: { previewPort } },
    });
    expect(
      sandbox.commands(first.value.id).some((command) => command.includes("--port 4000")),
    ).toBe(false);
    await sandbox.destroy(first.value.id);
    const restored = await acquireSandbox(options, running);
    expect(restored).toMatchObject({
      ok: true,
      value: { created: true, repository: { previewPort: 4000 } },
    });
    if (!restored.ok) throw new Error(restored.error.message);
    expect(
      sandbox.commands(restored.value.id).some((command) => command.includes("--port 4000")),
    ).toBe(true);
    expect(imported).toHaveBeenCalledOnce();
  },
);

it("rejects an invalid running preview marker instead of verifying a different configured port", async () => {
  const f = await fixture();
  await f.sandbox.writeFile(
    f.session.sandboxId ?? "",
    "/tmp/nap-repository-preview.json",
    '{"previewPort": "3000"}',
  );
  expect(await f.run()).toMatchObject({ ok: false, reason: "sandbox_unavailable" });
  expect(f.agent.calls).toBe(0);
});

it("prepares one dedicated branch, verifies without a preview, saves then publishes the completed job", async () => {
  const f = await fixture();
  f.finishJob.mockImplementation(async (request) => {
    expect(f.snapshots.all()).toHaveLength(1);
    expect(f.agent.calls).toBe(1);
    expect(request.outcome).toBe("verified");
    expect(foldJobs(await f.events.readFrom(sessionId, 0)).jobs.at(-1)?.phase).toBe("verified");
    return { ok: true, value: undefined };
  });
  expect(await f.run()).toMatchObject({ ok: true });
  expect(f.prepareJob).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ requestId: f.turnId }),
  );
  expect(f.finishJob).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ requestId: f.turnId, outcome: "verified" }),
  );
  const events = await f.events.readFrom(sessionId, 0);
  expect(events.some((event) => event.type === "preview.ready")).toBe(false);
  const verification = events.find((event) => event.type === "verification.completed");
  expect(verification?.payload.checks.some((check) => check.name === "preview")).toBe(false);
});

it("reports publication failure while keeping the verified job and snapshot", async () => {
  const f = await fixture();
  f.finishJob.mockResolvedValue({
    ok: false,
    error: { code: "unavailable", message: "Push failed. Retry publishing." },
  });
  expect(await f.run()).toMatchObject({ ok: true });
  const events = await f.events.readFrom(sessionId, 0);
  expect(foldJobs(events).jobs.at(-1)?.phase).toBe("verified");
  expect(events.at(-1)).toMatchObject({
    type: "system.notice",
    payload: { text: "Push failed. Retry publishing." },
  });
  expect(f.snapshots.all()).toHaveLength(1);
});

it("records the terminal repository outcome with the aborted signal after cancellation during verification", async () => {
  const f = await fixture();
  const controller = new AbortController();
  f.sandbox.script(/bun run typecheck/, () => {
    controller.abort();
    return { exitCode: 0 };
  });
  await f.run(controller.signal);
  expect(f.finishJob).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ outcome: "verified", signal: controller.signal }),
  );
  expect(controller.signal.aborted).toBe(true);
});

it("does not start a model after preparing the branch fails", async () => {
  const f = await fixture();
  f.prepareJob.mockResolvedValue({
    ok: false,
    error: { code: "conflict", message: "Workspace has uncommitted edits." },
  });
  expect(await f.run()).toMatchObject({ ok: false });
  expect(f.agent.calls).toBe(0);
  expect(foldJobs(await f.events.readFrom(sessionId, 0)).jobs.at(-1)?.phase).toBe("abandoned");
});

it("refuses a missing saved repository snapshot without importing over it", async () => {
  const f = await fixture();
  await f.snapshots.record({ projectId, key: "missing", gitSha: FAKE_COMMIT_SHA });
  const imported = vi.fn(source.initialBundle);
  const result = await openProject({
    sandbox: f.sandbox,
    objects: f.objects,
    snapshots: f.snapshots,
    projectId,
    source: { ...source, initialBundle: imported },
  });
  expect(result).toMatchObject({ ok: false, error: { reason: "snapshot_unavailable" } });
  expect(imported).not.toHaveBeenCalled();
});

it("checks cancellation before authorizing or acquiring a sandbox", async () => {
  const f = await fixture();
  const result = await acquireSandbox(
    {
      sandbox: f.sandbox,
      sessions: f.sessions,
      restore: null,
      ttlMs: 1,
      repository: f.repository,
      signal: AbortSignal.abort(),
    },
    f.session,
  );
  expect(result.ok).toBe(false);
  expect(f.repository.source).not.toHaveBeenCalled();
});

it("destroys an unusable imported sandbox and retains its saved snapshot", async () => {
  const sandbox = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
  sandbox.script(/git bundle verify/, { exitCode: 1, stderr: "not a bundle" });
  const objects = new InMemoryObjectStore();
  const snapshots = new InMemorySnapshotStore();
  await objects.put("saved", Buffer.from("bad archive"));
  await snapshots.record({ projectId, key: "saved", gitSha: FAKE_COMMIT_SHA });
  const imported = vi.fn(source.initialBundle);
  const destroyed = vi.spyOn(sandbox, "destroy");
  const result = await openProject({
    sandbox,
    objects,
    snapshots,
    projectId,
    source: { ...source, initialBundle: imported },
  });
  expect(result.ok).toBe(false);
  expect(imported).not.toHaveBeenCalled();
  expect(destroyed).toHaveBeenCalledOnce();
  expect(await objects.get("saved")).toMatchObject({ ok: true });
  expect(snapshots.all()).toHaveLength(1);
});

it("imports once, clears starter dependencies and runs configured setup again on restore", async () => {
  const sandbox = scriptGit(new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) }));
  const objects = new InMemoryObjectStore();
  const snapshots = new InMemorySnapshotStore();
  const imported = vi.fn(source.initialBundle);
  const repository = {
    ...source,
    initialBundle: imported,
    setupCommand: "bun install --frozen-lockfile",
  };
  const first = await openProject({ sandbox, objects, snapshots, projectId, source: repository });
  expect(first).toMatchObject({ ok: true, value: { installed: true } });
  if (!first.ok) return;
  const commands = sandbox.commands(first.value.sandboxId).join("\n");
  expect(commands.indexOf("git clean -fdx")).toBeLessThan(commands.indexOf("git reset --hard"));
  expect(commands).toContain("bun install --frozen-lockfile");
  await sandbox.destroy(first.value.sandboxId);
  const second = await openProject({ sandbox, objects, snapshots, projectId, source: repository });
  expect(second).toMatchObject({ ok: true, value: { installed: true } });
  expect(imported).toHaveBeenCalledOnce();
  expect(snapshots.all()).toHaveLength(1);
});

it.each([3000, null])(
  "uses running repository preview %s for ordinary and repair computer attempts after a settings edit",
  async (previewPort) => {
    const f = await fixture();
    f.repository.source = async () => ({
      ok: true,
      value: { ...source, previewPort: 4000, devCommand: "bun run dev --port 4000" },
    });
    const sandboxId = f.session.sandboxId;
    if (sandboxId === null) throw new Error("Missing running sandbox");
    await f.sandbox.writeFile(
      sandboxId,
      "/tmp/nap-repository-preview.json",
      JSON.stringify({ previewPort }),
    );
    if (previewPort !== null) f.sandbox.listen(sandboxId, previewPort);
    let checks = 0;
    f.sandbox.script(/bun run typecheck/, () => ({ exitCode: ++checks === 1 ? 1 : 0 }));
    expect((await f.run()).ok).toBe(true);
    expect(f.agent.requests.map((request) => request.promptSource)).toEqual([
      "user",
      "verification",
    ]);
    expect(f.agent.requests.map((request) => request.computer?.devServerUrl)).toEqual(
      previewPort === null
        ? [undefined, undefined]
        : ["http://localhost:3000", "http://localhost:3000"],
    );
    if (previewPort === null)
      expect(f.agent.requests.every((request) => request.computer === undefined)).toBe(true);
  },
);

it.each([3000, null])(
  "uses running repository preview %s when an open continues an interrupted repair",
  async (previewPort) => {
    const f = await fixture();
    f.repository.source = async () => ({
      ok: true,
      value: { ...source, previewPort: 4000, devCommand: "bun run dev --port 4000" },
    });
    const sandboxId = f.session.sandboxId;
    if (sandboxId === null) throw new Error("Missing running sandbox");
    await f.sandbox.writeFile(
      sandboxId,
      "/tmp/nap-repository-preview.json",
      JSON.stringify({ previewPort }),
    );
    if (previewPort !== null) f.sandbox.listen(sandboxId, previewPort);
    const base = {
      sessionId,
      turnId: crypto.randomUUID(),
      createdAt: "2026-10-24T00:00:00Z",
    };
    const jobId = crypto.randomUUID();
    await f.events.append({
      ...base,
      type: "job.started",
      payload: { jobId, objective: "Fix this repo" },
    });
    await f.events.append({
      ...base,
      type: "turn.completed",
      payload: {
        commitSha: FAKE_COMMIT_SHA,
        usage: { inputTokens: 0, outputTokens: 0 },
        durationMs: 1,
      },
    });
    await f.events.append({ ...base, type: "verification.started", payload: { jobId } });
    await f.events.append({
      ...base,
      type: "verification.completed",
      payload: {
        jobId,
        checks: [{ name: "typecheck", outcome: "failed", output: "Type error" }],
      },
    });
    const outcome = await f.runtime.resumeSession(sessionId, {
      turnId: crypto.randomUUID(),
      model: "anthropic/claude-sonnet-5",
    });
    expect(outcome.ok).toBe(true);
    expect(f.agent.requests).toHaveLength(1);
    expect(f.agent.requests[0]?.promptSource).toBe("verification");
    expect(f.agent.requests[0]?.computer?.devServerUrl).toBe(
      previewPort === null ? undefined : "http://localhost:3000",
    );
    if (previewPort === null) expect(f.agent.requests[0]?.computer).toBeUndefined();
  },
);
