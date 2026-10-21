import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { projects, turnRequests, users } from "./schema.ts";
import { createProjectSession } from "./session-bootstrap.ts";
import { PostgresSessionNavigationStore } from "./session-navigation-store.ts";

let connection: postgres.Sql;
let db: PostgresJsDatabase;
let store: PostgresSessionNavigationStore;
let owner: string;
beforeAll(async () => {
  connection = postgres(inject("postgresUrl"), { max: 3 });
  db = drizzle(connection);
  store = new PostgresSessionNavigationStore(db);
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Navigation owner" })
    .returning();
  owner = user?.id ?? "";
});
afterAll(async () => {
  await db.delete(users).where(eq(users.id, owner));
  await connection.end();
});
it("persists organization, refuses stale Undo and hides another owner's sessions", async () => {
  const created = await createProjectSession(db, { userId: owner, name: "Fix menu" });
  const page = await store.list(owner);
  const item = page.sessions.find((row) => row.projectId === created.projectId);
  if (!item) throw new Error("Missing session");
  expect(item.activity).toBe("ready");
  const pin = await store.change(owner, created.projectId, {
    revision: item.revision,
    change: { kind: "pin", pinned: true },
  });
  expect(pin.kind).toBe("saved");
  if (pin.kind !== "saved") throw new Error("Pin failed");
  expect(pin.navigation.pinned).toBe(true);
  expect(
    await store.change(owner, created.projectId, {
      revision: item.revision,
      change: { kind: "restore", navigation: item.navigation },
    }),
  ).toEqual({ kind: "conflict" });
  expect(
    await store.change(randomUUID(), created.projectId, {
      revision: pin.revision,
      change: { kind: "pin", pinned: false },
    }),
  ).toEqual({ kind: "missing" });
  expect((await store.list(randomUUID())).sessions).toEqual([]);
  expect(
    (await store.list(owner)).sessions.find((row) => row.projectId === created.projectId)
      ?.navigation.pinned,
  ).toBe(true);
});
it("refuses Done/archive while queued, and organization never releases the sandbox", async () => {
  const created = await createProjectSession(db, { userId: owner });
  await db
    .update(projects)
    .set({ sandboxId: "running-sandbox" })
    .where(eq(projects.id, created.projectId));
  const id = randomUUID();
  await db.insert(turnRequests).values({
    id,
    sessionId: created.sessionId,
    userId: owner,
    kind: "turn",
    message: "Work",
    model: "free",
  });
  const row = (await store.list(owner)).sessions.find(
    (entry) => entry.projectId === created.projectId,
  );
  expect(row?.activity).toBe("queued");
  for (const kind of ["done", "archive"] as const) {
    expect(
      await store.change(owner, created.projectId, { revision: 0, change: { kind, value: true } }),
    ).toEqual({ kind: "busy" });
  }
  await db
    .update(turnRequests)
    .set({ state: "done", finishedAt: new Date() })
    .where(eq(turnRequests.id, id));
  expect(
    (
      await store.change(owner, created.projectId, {
        revision: 0,
        change: { kind: "done", value: true },
      })
    ).kind,
  ).toBe("saved");
  const [project] = await db.select().from(projects).where(eq(projects.id, created.projectId));
  expect(project?.sandboxId).toBe("running-sandbox");
});
it("reorders atomically using every affected revision, with pagination independent of order", async () => {
  const a = await createProjectSession(db, { userId: owner, name: "A" });
  const b = await createProjectSession(db, { userId: owner, name: "B" });
  const rows = [
    { projectId: b.projectId, revision: 0 },
    { projectId: a.projectId, revision: 0 },
  ];
  expect((await store.reorder(owner, { section: "active", rows })).kind).toBe("saved");
  expect((await store.reorder(owner, { section: "active", rows })).kind).toBe("conflict");
  const all = await store.list(owner);
  expect(all.sessions.find((row) => row.projectId === b.projectId)?.navigation.position).toBe(0);
  expect(all.sessions.find((row) => row.projectId === a.projectId)?.navigation.position).toBe(1);
});

it("allows reordering a Done session reopened by a later request", async () => {
  const created = await createProjectSession(db, { userId: owner });
  await store.change(owner, created.projectId, {
    revision: 0,
    change: { kind: "done", value: true },
  });
  await db.insert(turnRequests).values({
    id: randomUUID(),
    sessionId: created.sessionId,
    userId: owner,
    kind: "turn",
    message: "Continue",
    model: "free",
    createdAt: new Date(Date.now() + 1000),
  });
  expect(
    await store.reorder(owner, {
      section: "active",
      rows: [{ projectId: created.projectId, revision: 1 }],
    }),
  ).toEqual({ kind: "saved" });
});
