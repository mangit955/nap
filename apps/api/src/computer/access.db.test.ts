import { randomUUID } from "node:crypto";
import { PostgresProjectComputerAccess } from "@nap/db/postgres-project-computer-access";
import { PostgresSessionStore } from "@nap/db/postgres-session-store";
import { PostgresTurnQueue } from "@nap/db/postgres-turn-queue";
import { projects, sessions, turnRequests, users } from "@nap/db/schema";
import { enqueueRequest } from "@nap/db/testing/enqueue-request";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { FakeSandboxDesktop } from "@nap/sandbox/testing/fake-sandbox-desktop";
import { ComputerControlGrantSchema } from "@nap/shared/computer-access";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { createLogger } from "../logger.ts";

// These exercise HTTP composition against the real guard. Its separate-process races stay in DB.
let client: postgres.Sql;
let inputClient: postgres.Sql;
let db: PostgresJsDatabase;
let queue: PostgresTurnQueue;
beforeAll(() => {
  client = postgres(inject("postgresUrl"), { max: 4, connection: { lock_timeout: 2000 } });
  inputClient = postgres(inject("postgresUrl"), { max: 2, connection: { lock_timeout: 2000 } });
  db = drizzle(client);
  queue = new PostgresTurnQueue(db);
});
beforeEach(async () => {
  await db.delete(turnRequests);
});
afterAll(async () => {
  await Promise.all([client.end(), inputClient.end()]);
});

async function fixture() {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@test.invalid`, name: "Owner" })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ userId: user!.id, name: "Desktop", slug: randomUUID(), sandboxId: "box" })
    .returning();
  const [session, sibling] = await db
    .insert(sessions)
    .values([
      { projectId: project!.id, title: "current" },
      { projectId: project!.id, title: "older" },
    ])
    .returning();
  const desktop = new FakeSandboxDesktop({ bytes: new Uint8Array(), width: 1024, height: 768 });
  const guard = new PostgresProjectComputerAccess(drizzle(inputClient));
  const guardOperation = { settled: false };
  const app = createApp({
    logger: createLogger({ level: "silent" }, { write: () => {} }),
    authenticate: async () => ({ userId: user!.id, isAnonymous: false }),
    stream: {
      store: new InMemoryEventStore(),
      bus: new InMemoryEventBus(),
      upgradeWebSocket: async () => new Response(),
    },
    computerAccess: {
      sessions: new PostgresSessionStore(db),
      desktop,
      access: {
        withIdleProject: (request, operation) =>
          guard.withIdleProject(request, async (computer) => {
            guardOperation.settled = false;
            try {
              return await operation(computer);
            } finally {
              guardOperation.settled = true;
            }
          }),
      },
      secret: "integration-secret",
    },
  });
  const base = `/sessions/${session!.id}/computer`;
  const post = async (route: string, body: unknown = {}) =>
    app.request(`${base}/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const grant = async () => {
    const response = await post("control");
    expect(response.status).toBe(200);
    return ComputerControlGrantSchema.parse(await response.json()).grant;
  };
  return {
    app,
    guardOperation,
    desktop,
    base,
    post,
    grant,
    projectId: project!.id,
    userId: user!.id,
    siblingId: sibling!.id,
  };
}

it("denies a sibling session's lease and keeps the old grant stale after that claim completes", async () => {
  const f = await fixture();
  const grant = await f.grant();
  const request = await enqueueRequest(queue, {
    sessionId: f.siblingId,
    userId: f.userId,
    kind: "turn",
    message: "build",
    model: "openai/gpt-5-mini",
    billsToUser: false,
  });
  // Queued work alone allows takeover.
  expect((await f.app.request(`${f.base}/control`)).status).toBe(200);
  expect((await queue.claim("worker"))?.id).toBe(request.id);
  for (const response of [
    await f.app.request(`${f.base}/control`),
    await f.post("control"),
    await f.post("input", { grant, actions: [{ action: "key", text: "Return" }] }),
  ]) {
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "busy" });
  }
  expect(await queue.settle(request.id, "worker", "done")).toBe(true);
  const response = await f.post("input", { grant, actions: [{ action: "key", text: "Return" }] });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "stale_grant" });
  expect(f.desktop.actions).toEqual([]);
  await f.app.request(`${f.base}/stream`);
  expect(
    (
      await f.post("input", {
        grant: await f.grant(),
        actions: [{ action: "key", text: "Return" }],
      })
    ).status,
  ).toBe(200);
});

it("rejects a sandbox replacement using the locked row without relying on the revision", async () => {
  const f = await fixture();
  const grant = await f.grant();
  await db.update(projects).set({ sandboxId: "replacement" }).where(eq(projects.id, f.projectId));
  expect(
    (await f.post("input", { grant, actions: [{ action: "key", text: "Return" }] })).status,
  ).toBe(409);
  expect(f.desktop.actions).toEqual([]);
});

it("holds the real row lock through abort until the adapter's physical input settles", async () => {
  const f = await fixture();
  const grant = await f.grant();
  const abort = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(abort.signal);
  let release = () => {};
  let enter = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const act = vi.spyOn(f.desktop, "act").mockImplementation(async () => {
    enter();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ok: true, value: { kind: "none" } };
  });
  let pending: Promise<Response> | undefined;
  try {
    pending = f.post("input", { grant, actions: Array(2).fill({ action: "key", text: "Return" }) });
    await entered;
    abort.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.guardOperation.settled).toBe(false);
    // NOWAIT observes the resource directly, even though the HTTP deadline has expired.
    await expect(
      db.transaction(async (tx) => {
        await tx
          .select()
          .from(projects)
          .where(eq(projects.id, f.projectId))
          .for("update", { noWait: true });
      }),
    ).rejects.toThrow();
    release();
    expect((await pending).status).toBe(503);
    expect(act).toHaveBeenCalledTimes(1);
    await db.transaction(async (tx) => {
      await tx
        .select()
        .from(projects)
        .where(eq(projects.id, f.projectId))
        .for("update", { noWait: true });
    });
  } finally {
    release();
    await pending;
    timeout.mockRestore();
  }
});
