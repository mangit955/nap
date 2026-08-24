import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemoryProjectSandboxStore } from "@nap/db/testing/in-memory-project-sandbox-store";
import { FAKE_OWNER, InMemoryProjectStore } from "@nap/db/testing/in-memory-project-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemoryTurnQueue } from "@nap/db/testing/in-memory-turn-queue";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { ProjectSummary } from "@nap/shared/ports/project-store";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import type { SandboxLimits } from "../turns/sandbox-quota.ts";
import type { ProjectRouteDeps } from "./routes.ts";

const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const SESSION = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const UNKNOWN = "6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e";
const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80912";
const PAID_MODEL = "openai/gpt-5.6-luna";
const FREE_MODEL = "openai/gpt-oss-20b:free";

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
/** Where an accepted open is written down. Nothing in these tests claims from it. */
let queue: InMemoryTurnQueue;
/** The model settings the routes are built with. */
let models: ProjectRouteDeps["models"];
let limits: SandboxLimits | undefined;
/** The log the app writes to, so a close's announcement can be read back. */
let events: InMemoryEventStore;

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
  queue = new InMemoryTurnQueue();
  // Required rather than optional, because a queued resume carries a concrete model: the row is
  // written before anything can default one, and the default that would be applied is paid.
  models = {
    allowedModels: [PAID_MODEL, FREE_MODEL],
    freeModel: FREE_MODEL,
    defaultModel: PAID_MODEL,
  };
  limits = undefined;
  events = new InMemoryEventStore();
});

function app() {
  return createApp({
    logger: silent(),
    // Every guarded route needs a caller; this stands in for a signed-in session cookie.
    authenticate: async () => ({ userId: FAKE_OWNER, isAnonymous: false }),
    stream: {
      store: events,
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
      isBusy: async (sessionIds) => sessionIds.some((id) => running.has(id)),
      events: { events, bus: new InMemoryEventBus() },
      queue,
      models,
      ...(limits === undefined ? {} : { limits: { projects, sandboxes: limits } }),
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

describe("GET /projects/:projectId/thumbnail", () => {
  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  it("answers with the picture, as an image", async () => {
    // The client is an `<img>`, so anything but PNG bytes under an image content type means a
    // fetch and a data URL to show something the browser can request for itself.
    await objects.put(`projects/${PROJECT}/thumbnail.png`, PNG);

    const res = await app().request(`/projects/${PROJECT}/thumbnail`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...PNG]);
  });

  it("is 404 for a project that has never been photographed", async () => {
    // The ordinary state of every project until a turn completes with a browser configured.
    // The card asks anyway and falls back to its colour, so this must be a plain miss.
    const res = await app().request(`/projects/${PROJECT}/thumbnail`);

    expect(res.status).toBe(404);
  });

  it("tells somebody else's project apart from a missing one in no way at all", async () => {
    // A 403 would confirm the project exists, which is the one thing a stranger must not learn
    // from asking. The lookup is scoped to the caller, so this is the same 404 as above.
    await objects.put(`projects/${UNKNOWN}/thumbnail.png`, PNG);

    const res = await app().request(`/projects/${UNKNOWN}/thumbnail`);

    expect(res.status).toBe(404);
  });

  it("keeps the picture out of shared caches", async () => {
    // It is a screenshot of somebody's own app. A public cache would hand it to whoever asks
    // for that URL next.
    await objects.put(`projects/${PROJECT}/thumbnail.png`, PNG);

    const res = await app().request(`/projects/${PROJECT}/thumbnail`);

    expect(res.headers.get("cache-control")).toMatch(/private/);
  });
});

describe("POST /projects/:projectId/close", () => {
  it("does not stop to photograph the project on the way out", async () => {
    // Closing takes no new picture: the last completed turn already captured the app, and
    // waiting for a browser here would hold the request open for the length of a page load
    // before teardown even started. The project keeps the thumbnail it already had, and the
    // only object this writes is the snapshot bundle.
    //
    // Asserted here as well as in `close-project.test.ts` because the route is where a browser
    // would be handed over, and a route that quietly started passing one again would put the
    // wait back without any test of the sequence noticing.
    const shelved = new Uint8Array([137, 80, 78, 71]);
    await objects.put(`projects/${PROJECT}/thumbnail.png`, shelved);

    await app().request(`/projects/${PROJECT}/close`, { method: "POST" });

    // On the bytes rather than on the key: a fresh capture writes to the same key, so a count
    // of the objects would be identical either way and the test would pass on the thing it
    // exists to catch.
    const kept = await objects.get(`projects/${PROJECT}/thumbnail.png`);
    expect(kept.ok && [...kept.value]).toEqual([...shelved]);
  });

  it("puts the project away and says where the bytes went", async () => {
    const res = await app().request(`/projects/${PROJECT}/close`, { method: "POST" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ closed: true, key: expect.any(String) });
    expect(objects.keys()).toHaveLength(1);
    expect(projectSandboxes.get(PROJECT)?.sandboxId).toBeNull();
  });

  it("tells the project's sessions that the preview has stopped", async () => {
    // A close in one tab has to reach the others: they are showing an address that stops
    // answering the moment this returns.
    await app().request(`/projects/${PROJECT}/close`, { method: "POST" });

    expect(await events.readFrom(SESSION, 0)).toMatchObject([{ type: "preview.stopped" }]);
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

describe("POST /projects/:projectId/open", () => {
  beforeEach(() => {
    projects = new InMemoryProjectStore([summary({ sandboxId: null, status: "idle" })]);
  });

  it("accepts, and queues a resume for the project's newest session", async () => {
    // Written down rather than run here. A restore that executed in this process would continue
    // whatever job the log left open *without a lease*, beside a worker turn on the same session
    // — which is the two-sandbox failure the lease exists to prevent.
    const res = await app().request(`/projects/${PROJECT}/open`, { method: "POST" });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ opened: true });
    // Durable *before* the answer was written, which is the whole of what 202 now promises.
    expect(queue.enqueued).toEqual([
      expect.objectContaining({ sessionId: SESSION, kind: "resume", message: null }),
    ]);
  });

  it("resolves what a continued job may run on, and who pays, before it is queued", async () => {
    // Opening can pick a job back up where a restart left it, and that spends tokens. Without
    // this, a user with their own key has their repairs billed to the deployment.
    models = {
      keys: async () => ({ platform: "openrouter", apiKey: "sk-or-theirs" }),
      allowedModels: [PAID_MODEL, FREE_MODEL],
      freeModel: FREE_MODEL,
      defaultModel: PAID_MODEL,
    };

    await app().request(`/projects/${PROJECT}/open`, { method: "POST" });

    // `billsToUser` rather than the key itself: the worker re-opens it by user id, so plaintext
    // credentials never reach the queue, a query log or a backup.
    expect(queue.enqueued).toEqual([
      expect.objectContaining({ model: PAID_MODEL, billsToUser: true }),
    ]);
  });

  it("leaves a caller with no key of their own on the model this deployment covers", async () => {
    await app().request(`/projects/${PROJECT}/open`, { method: "POST" });

    expect(queue.enqueued).toEqual([
      expect.objectContaining({ model: FREE_MODEL, billsToUser: false }),
    ]);
  });

  it("refuses a caller whose key cannot reach any model here, rather than queueing one", async () => {
    // An Anthropic key against an allowlist with no Claude model on it. Rare, but the resolver
    // can say no with nothing requested, and a queued row needs a model that will actually run.
    models = {
      keys: async () => ({ platform: "anthropic", apiKey: "sk-ant-theirs" }),
      allowedModels: [PAID_MODEL, FREE_MODEL],
      freeModel: FREE_MODEL,
      defaultModel: PAID_MODEL,
    };

    const res = await app().request(`/projects/${PROJECT}/open`, { method: "POST" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "model_not_allowed" });
    expect(queue.enqueued).toEqual([]);
  });

  it("says so, rather than queueing a second sandbox, when it is already running", async () => {
    projects = new InMemoryProjectStore([summary()]);

    const res = await app().request(`/projects/${PROJECT}/open`, { method: "POST" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ opened: false, reason: "already_running" });
    expect(queue.enqueued).toEqual([]);
  });

  it("refuses at the sandbox quota, in the same shape a turn is refused in", async () => {
    // Resuming creates a sandbox, so skipping the check here would be a hole straight through
    // the only ceiling on the bill — and the browser reads one `code` for both routes.
    limits = { perUser: 1, total: 10 };
    projects = new InMemoryProjectStore([
      summary({ sandboxId: null, status: "idle" }),
      summary({ projectId: UNKNOWN, sandboxId: "another", status: "ready" }),
    ]);

    const res = await app().request(`/projects/${PROJECT}/open`, { method: "POST" });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: "sandbox_quota_exceeded" });
    expect(queue.enqueued).toEqual([]);
  });

  it("is 404 for a project that is not yours", async () => {
    const res = await app().request(`/projects/${UNKNOWN}/open`, { method: "POST" });

    expect(res.status).toBe(404);
    expect(queue.enqueued).toEqual([]);
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
      authenticate: async () => ({ userId: FAKE_OWNER, isAnonymous: false }),
      stream: {
        store: new InMemoryEventStore(),
        bus: new InMemoryEventBus(),
        upgradeWebSocket: async () => new Response(null),
      },
    });

    expect((await bare.request("/projects")).status).toBe(404);
  });
});

describe("PATCH /projects/:projectId", () => {
  const rename = (projectId: string, body: unknown) =>
    app().request(`/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("renames the project and answers the record it wrote", async () => {
    // The updated record rather than a bare 204, so the client re-renders from what the server
    // actually stored instead of from what it hoped it wrote.
    const res = await rename(PROJECT, { name: "Small To-do App" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ name: "Small To-do App" });
    expect((await projects.get(PROJECT, FAKE_OWNER))?.name).toBe("Small To-do App");
  });

  it("trims what it was given", async () => {
    await rename(PROJECT, { name: "  Padded  " });

    expect((await projects.get(PROJECT, FAKE_OWNER))?.name).toBe("Padded");
  });

  it("refuses an empty name", async () => {
    // A blank bar is worse than "Untitled project": it reads as a project whose record failed
    // to load rather than one nobody has named.
    const res = await rename(PROJECT, { name: "   " });

    expect(res.status).toBe(400);
    expect((await projects.get(PROJECT, FAKE_OWNER))?.name).toBe("Todo app");
  });

  it("refuses a name too long for anything to show", async () => {
    const res = await rename(PROJECT, { name: "x".repeat(61) });

    expect(res.status).toBe(400);
  });

  it("refuses a body with no name in it", async () => {
    expect((await rename(PROJECT, {})).status).toBe(400);
  });

  it("answers 404 for a project that is not there", async () => {
    expect((await rename(UNKNOWN, { name: "Nope" })).status).toBe(404);
  });

  it("answers 400 for something that is not a project id", async () => {
    expect((await rename("not-a-uuid", { name: "Nope" })).status).toBe(400);
  });

  it("renames while a turn is running", async () => {
    // Unlike close and delete, which take the sandbox away from underneath an agent midway
    // through writing files. A name is a label on a row; renaming during a turn breaks nothing,
    // and refusing would be a rule with no reason behind it.
    running.add(SESSION);

    const res = await rename(PROJECT, { name: "Renamed Mid-turn" });

    expect(res.status).toBe(200);
  });
});
