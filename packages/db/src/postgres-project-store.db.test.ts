import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PostgresProjectStore } from "./postgres-project-store.ts";
import { events, projects, sessions, snapshots, users } from "./schema.ts";

/**
 * Against a real Postgres, because two of the three promises here are the database's rather
 * than this class's: the ordering comes from a sort the query has to get right, and the delete
 * relies on `on delete cascade` doing what the schema says. A fake would agree with itself
 * about both.
 *
 * The container is shared across the `db` project, so nothing may assume an empty table —
 * every assertion is scoped to ids it seeded.
 */

let sql: postgres.Sql;
let db: PostgresJsDatabase;
let store: PostgresProjectStore;
/**
 * One owner for the whole file, so `list` sees everything seeded here and the ordering tests
 * still mean what they meant before projects had owners. The ownership tests at the bottom
 * make their own second user.
 */
let owner: string;

beforeAll(async () => {
  sql = postgres(inject("postgresUrl"), { max: 4 });
  db = drizzle(sql);
  store = new PostgresProjectStore(db);
  owner = await seedUser();
});

afterAll(async () => {
  await sql.end();
});

type SeedOptions = {
  name?: string;
  updatedAt?: Date;
  sandboxId?: string | null;
  status?: "creating" | "ready" | "idle";
  /** Defaults to the file's shared owner; the ownership tests pass a second user. */
  userId?: string;
};

async function seedUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Ada" })
    .returning();
  return user?.id ?? "";
}

async function seedProject(options: SeedOptions = {}): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({
      userId: options.userId ?? owner,
      name: options.name ?? "Todo app",
      slug: `todo-${randomUUID()}`,
      sandboxId: options.sandboxId ?? null,
      status: options.status ?? "creating",
      updatedAt: options.updatedAt ?? new Date(),
    })
    .returning();
  return project?.id ?? "";
}

async function seedSession(projectId: string, createdAt?: Date): Promise<string> {
  const [session] = await db
    .insert(sessions)
    .values({
      projectId,
      title: "First session",
      ...(createdAt === undefined ? {} : { createdAt }),
    })
    .returning();
  return session?.id ?? "";
}

describe("list", () => {
  it("orders by the most recent activity, not by creation", async () => {
    // The list page exists to get you back to what you were doing, and what you were doing is
    // the project that moved last — which is not the one that was made last. So the two orders
    // are deliberately opposed here: the older project is inserted second, and only a sort on
    // `updated_at` puts the busier one first. Sorted the obvious way, this fails.
    const fresh = await seedProject({ updatedAt: new Date("2026-08-09T00:00:00.000Z") });
    const stale = await seedProject({ updatedAt: new Date("2026-01-01T00:00:00.000Z") });

    const listed = (await store.list(owner)).map((project) => project.projectId);

    expect(listed.indexOf(fresh)).toBeLessThan(listed.indexOf(stale));
  });

  it("lists sessions newest first, so opening a project lands in the last conversation", async () => {
    const projectId = await seedProject();
    const older = await seedSession(projectId, new Date("2026-01-01T00:00:00.000Z"));
    const newest = await seedSession(projectId, new Date("2026-08-09T00:00:00.000Z"));

    const found = (await store.list(owner)).find((project) => project.projectId === projectId);

    expect(found?.sessionIds).toEqual([newest, older]);
  });

  it("includes a project that has no session yet rather than dropping it", async () => {
    // A row with no conversation in it is still a project someone can see and delete. Losing
    // it from the listing would leave something that exists and cannot be reached.
    const projectId = await seedProject();

    const found = (await store.list(owner)).find((project) => project.projectId === projectId);

    expect(found).toMatchObject({ sessionIds: [] });
  });

  it("reports the sandbox and status a project is in", async () => {
    const projectId = await seedProject({ sandboxId: "sbx_live", status: "ready" });

    const found = (await store.list(owner)).find((project) => project.projectId === projectId);

    expect(found).toMatchObject({ sandboxId: "sbx_live", status: "ready", name: "Todo app" });
  });
});

describe("get", () => {
  it("returns one project by id", async () => {
    const projectId = await seedProject({ name: "Notes" });
    const sessionId = await seedSession(projectId);

    await expect(store.get(projectId, owner)).resolves.toMatchObject({
      projectId,
      name: "Notes",
      sessionIds: [sessionId],
    });
  });

  it("is null for a project that does not exist", async () => {
    await expect(store.get(randomUUID(), owner)).resolves.toBeNull();
  });
});

describe("delete", () => {
  it("takes its sessions, events and snapshot rows with it", async () => {
    // The cascade is the schema's promise, and this is the only place anything checks it. A
    // session or an event left behind points at a project that is gone.
    const projectId = await seedProject();
    const sessionId = await seedSession(projectId);
    await db.insert(events).values({
      sessionId,
      turnId: randomUUID(),
      seq: 1,
      type: "user.message",
      payload: { text: "hello" },
    });
    await db
      .insert(snapshots)
      .values({ projectId, r2Key: `projects/${projectId}/1-abc.bundle`, gitSha: "abc" });

    await expect(store.delete(projectId, owner)).resolves.toBe(true);

    expect(await db.select().from(projects).where(eq(projects.id, projectId))).toEqual([]);
    expect(await db.select().from(sessions).where(eq(sessions.projectId, projectId))).toEqual([]);
    expect(await db.select().from(events).where(eq(events.sessionId, sessionId))).toEqual([]);
    expect(await db.select().from(snapshots).where(eq(snapshots.projectId, projectId))).toEqual([]);
  });

  it("reports false for a project that was already gone", async () => {
    await expect(store.delete(randomUUID(), owner)).resolves.toBe(false);
  });
});

describe("ownership", () => {
  it("does not list another user's projects", async () => {
    // The whole point of the scoping. Without the `where` on `user_id`, every project in the
    // database appears on everybody's list page.
    const stranger = await seedUser();
    const theirs = await seedProject({ userId: stranger, name: "Not yours" });

    expect((await store.list(owner)).map((p) => p.projectId)).not.toContain(theirs);
    expect((await store.list(stranger)).map((p) => p.projectId)).toContain(theirs);
  });

  it("reports another user's project as absent rather than forbidden", async () => {
    // Not a 403's worth of information: confirming the row exists is a fact about somebody
    // else's data, and `null` is what the route turns into a 404.
    const stranger = await seedUser();
    const theirs = await seedProject({ userId: stranger });

    await expect(store.get(theirs, owner)).resolves.toBeNull();
  });

  it("refuses to delete another user's project, and leaves the row where it was", async () => {
    const stranger = await seedUser();
    const theirs = await seedProject({ userId: stranger });

    await expect(store.delete(theirs, owner)).resolves.toBe(false);
    expect(await db.select().from(projects).where(eq(projects.id, theirs))).toHaveLength(1);
  });
});
