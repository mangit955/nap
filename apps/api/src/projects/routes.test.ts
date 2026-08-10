import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemoryProjectSandboxStore } from "@nap/db/testing/in-memory-project-sandbox-store";
import { FAKE_OWNER, InMemoryProjectStore } from "@nap/db/testing/in-memory-project-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { ProjectSummary } from "@nap/shared/ports/project-store";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createLogger } from "../logger.ts";

const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const SESSION = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const UNKNOWN = "6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e";
const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80912";

const silent = () => createLogger({ level: "silent" }, { write: () => {} });

let projects: InMemoryProjectStore;
let projectSandboxes: InMemoryProjectSandboxStore;
let snapshots: InMemorySnapshotStore;
let objects: InMemoryObjectStore;
let sandbox: InMemorySandboxManager;
let sandboxId: string;
/** Sessions the test declares to have a turn running. */
let running: Set<string>;
let created: { projectId: string; sessionId: string };

function summary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    projectId: PROJECT,
    name: "Todo app",
    status: "ready",
    sandboxId,
    updatedAt: "2026-08-09T11:00:00.000Z",
    sessionIds: [SESSION],
    ...overrides,
  };
}

beforeEach(async () => {
  sandbox = new InMemorySandboxManager()
    .script(/git rev-parse HEAD/, { exitCode: 0, stdout: `${SHA}\n` })
    .script(/git bundle create/, {
      exitCode: 0,
      stdout: Buffer.from("PACK-bundle-bytes").toString("base64"),
    });
  const sb = await sandbox.create(PROJECT);
  if (!sb.ok) throw new Error("could not create a sandbox");
  sandboxId = sb.value.id;

  projects = new InMemoryProjectStore([summary()]);
  projectSandboxes = new InMemoryProjectSandboxStore([
    { projectId: PROJECT, sandboxId, sessionIds: [SESSION], lastActiveAt: "2026-08-09T11:00:00Z" },
  ]);
  snapshots = new InMemorySnapshotStore();
  objects = new InMemoryObjectStore();
  running = new Set();
  created = { projectId: UNKNOWN, sessionId: SESSION };
});

function app() {
  return createApp({
    logger: silent(),
    // Every guarded route needs a caller; this stands in for a signed-in session cookie.
    authenticate: async () => ({ userId: FAKE_OWNER }),
    stream: {
      store: new InMemoryEventStore(),
      bus: new InMemoryEventBus(),
      upgradeWebSocket: async () => new Response(null),
    },
    projects: {
      projects,
      projectSandboxes,
      snapshots,
      objects,
      sandbox,
      createProject: async () => created,
      isBusy: (sessionIds) => sessionIds.some((id) => running.has(id)),
    },
  });
}

describe("GET /projects", () => {
  it("lists what there is", async () => {
    const res = await app().request("/projects");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      projects: [{ projectId: PROJECT, name: "Todo app" }],
    });
  });

  it("is an empty list rather than an error when there is nothing yet", async () => {
    // The first thing a new user sees. A 404 here would be a broken app rather than an empty one.
    projects = new InMemoryProjectStore();

    const res = await app().request("/projects");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ projects: [] });
  });
});

describe("POST /projects", () => {
  it("answers with the ids the client needs to open it", async () => {
    const res = await app().request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Notes" }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual(created);
  });

  it("accepts a request with no body at all", async () => {
    // The browser sends `{}` and means "anything". So does an empty body.
    const res = await app().request("/projects", { method: "POST" });

    expect(res.status).toBe(201);
  });

  it("refuses a name that is not a string", async () => {
    const res = await app().request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: 42 }),
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /projects/:projectId", () => {
  it("returns the project, with the session opening it lands in", async () => {
    const res = await app().request(`/projects/${PROJECT}`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ sessionIds: [SESSION] });
  });

  it("is 404 for a project that does not exist", async () => {
    const res = await app().request(`/projects/${UNKNOWN}`);

    expect(res.status).toBe(404);
  });

  it("is 400 for an id that is not a uuid", async () => {
    // Distinct from 404 on purpose: a malformed id never reached a lookup at all.
    const res = await app().request("/projects/nope");

    expect(res.status).toBe(400);
  });
});

describe("POST /projects/:projectId/close", () => {
  it("puts the project away and says where the bytes went", async () => {
    const res = await app().request(`/projects/${PROJECT}/close`, { method: "POST" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ closed: true, key: expect.any(String) });
    expect(objects.keys()).toHaveLength(1);
    expect(projectSandboxes.get(PROJECT)?.sandboxId).toBeNull();
  });

  it("refuses while a turn is running", async () => {
    // The agent is mid-write and its events are still being appended. Taking the sandbox away
    // leaves a half-finished project and a transcript that stops mid-sentence.
    running.add(SESSION);

    const res = await app().request(`/projects/${PROJECT}/close`, { method: "POST" });

    expect(res.status).toBe(409);
    expect(objects.keys()).toEqual([]);
    await expect(sandbox.resume(sandboxId)).resolves.toMatchObject({ ok: true });
  });

  it("says so, rather than failing, when the project is already put away", async () => {
    projects = new InMemoryProjectStore([summary({ sandboxId: null, status: "idle" })]);

    const res = await app().request(`/projects/${PROJECT}/close`, { method: "POST" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ closed: false });
  });

  it("reports a snapshot that could not be taken, leaving the sandbox alone", async () => {
    objects.failWith({ code: "unavailable", message: "R2 is not answering" });

    const res = await app().request(`/projects/${PROJECT}/close`, { method: "POST" });

    expect(res.status).toBe(503);
    await expect(sandbox.resume(sandboxId)).resolves.toMatchObject({ ok: true });
  });
});

describe("DELETE /projects/:projectId", () => {
  beforeEach(async () => {
    const key = `projects/${PROJECT}/1-abc.bundle`;
    await objects.put(key, new TextEncoder().encode("PACK"));
    await snapshots.record({ projectId: PROJECT, key, gitSha: "abc" });
  });

  it("removes the project and its objects", async () => {
    const res = await app().request(`/projects/${PROJECT}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ deleted: true, objectsDeleted: 1 });
    expect(objects.keys()).toEqual([]);
    await expect(projects.get(PROJECT, FAKE_OWNER)).resolves.toBeNull();
  });

  it("refuses while a turn is running", async () => {
    running.add(SESSION);

    const res = await app().request(`/projects/${PROJECT}`, { method: "DELETE" });

    expect(res.status).toBe(409);
    await expect(projects.get(PROJECT, FAKE_OWNER)).resolves.not.toBeNull();
    expect(objects.keys()).toHaveLength(1);
  });

  it("is 404 for a project that does not exist", async () => {
    const res = await app().request(`/projects/${UNKNOWN}`, { method: "DELETE" });

    expect(res.status).toBe(404);
  });

  it("reports a storage failure as retryable, having removed nothing", async () => {
    objects.failWith({ code: "unavailable", message: "R2 is not answering" });

    const res = await app().request(`/projects/${PROJECT}`, { method: "DELETE" });

    expect(res.status).toBe(503);
    await expect(projects.get(PROJECT, FAKE_OWNER)).resolves.not.toBeNull();
  });
});

describe("an app built without project routes", () => {
  it("has none, rather than routes that fail when called", async () => {
    const bare = createApp({
      logger: silent(),
      // Signed in, so a 404 here is about the route not existing rather than about who is
      // asking — which is what this test is for.
      authenticate: async () => ({ userId: FAKE_OWNER }),
      stream: {
        store: new InMemoryEventStore(),
        bus: new InMemoryEventBus(),
        upgradeWebSocket: async () => new Response(null),
      },
    });

    expect((await bare.request("/projects")).status).toBe(404);
  });
});
