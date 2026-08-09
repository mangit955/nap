import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PostgresSessionStore } from "./postgres-session-store.ts";
import { projects, sessions, users } from "./schema.ts";

/**
 * Against a real Postgres, because the one thing worth proving here is a shape the schema
 * decides rather than this class: a session's sandbox lives on its **project**, so two
 * sessions in the same project share one sandbox, and a fake that stored it per session
 * would agree with itself forever.
 *
 * The container is shared across the `db` project, so nothing here assumes an empty table.
 */

let sql: postgres.Sql;
let db: PostgresJsDatabase;
let store: PostgresSessionStore;

beforeAll(() => {
  sql = postgres(inject("postgresUrl"), { max: 4 });
  db = drizzle(sql);
  store = new PostgresSessionStore(db);
});

afterAll(async () => {
  await sql.end();
});

async function seedProject(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Ada" })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ userId: user?.id ?? "", name: "Todo app", slug: `todo-${randomUUID()}` })
    .returning();
  return project?.id ?? "";
}

async function seedSession(projectId: string): Promise<string> {
  const [session] = await db
    .insert(sessions)
    .values({ projectId, title: "First session" })
    .returning();
  return session?.id ?? "";
}

describe("get", () => {
  it("returns the session's project and no sandbox before one exists", async () => {
    const projectId = await seedProject();
    const sessionId = await seedSession(projectId);

    await expect(store.get(sessionId)).resolves.toEqual({ sessionId, projectId, sandboxId: null });
  });

  it("is null for a session that does not exist", async () => {
    // A caller error rather than a turn failure — the port says so, and the runtime turns it
    // into an `internal` outcome with no event, since an event needs a session to belong to.
    await expect(store.get(randomUUID())).resolves.toBeNull();
  });
});

describe("setSandboxId", () => {
  it("records the sandbox so the next turn resumes it", async () => {
    const projectId = await seedProject();
    const sessionId = await seedSession(projectId);

    await store.setSandboxId(sessionId, "sbx_abc");

    await expect(store.get(sessionId)).resolves.toMatchObject({ sandboxId: "sbx_abc" });
  });

  it("replaces a sandbox that was recorded earlier", async () => {
    // A project whose sandbox was reaped gets a new one, and the old id must not survive to
    // be resumed — resuming a destroyed sandbox fails the turn.
    const projectId = await seedProject();
    const sessionId = await seedSession(projectId);

    await store.setSandboxId(sessionId, "sbx_old");
    await store.setSandboxId(sessionId, "sbx_new");

    await expect(store.get(sessionId)).resolves.toMatchObject({ sandboxId: "sbx_new" });
  });

  it("shares the sandbox with every session in the same project", async () => {
    // The column lives on `projects`. A second conversation about the same project must land
    // in the workspace the first one built, not in a fresh template.
    const projectId = await seedProject();
    const first = await seedSession(projectId);
    const second = await seedSession(projectId);

    await store.setSandboxId(first, "sbx_shared");

    await expect(store.get(second)).resolves.toMatchObject({ projectId, sandboxId: "sbx_shared" });
  });

  it("leaves other projects alone", async () => {
    const mine = await seedProject();
    const theirs = await seedProject();
    const mySession = await seedSession(mine);
    const theirSession = await seedSession(theirs);

    await store.setSandboxId(mySession, "sbx_mine");

    await expect(store.get(theirSession)).resolves.toMatchObject({ sandboxId: null });
  });

  it("throws for a session that does not exist", async () => {
    // The real store would silently update nothing. A caller reaching this line has already
    // looked the session up, so it is a bug in the caller rather than an outcome to return —
    // the in-memory fake makes the same promise.
    await expect(store.setSandboxId(randomUUID(), "sbx_x")).rejects.toThrow();
  });
});

describe("the status a project is in", () => {
  it("moves a project to ready when a sandbox starts serving it", async () => {
    // Nothing else ever moved a project off `creating`, so every project in a real database
    // claimed to be mid-creation forever — including ones that had been running for hours.
    const projectId = await seedProject();
    const sessionId = await seedSession(projectId);

    await store.setSandboxId(sessionId, "sbx_live");

    const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(row?.status).toBe("ready");
  });
});
