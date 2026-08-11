import { randomUUID } from "node:crypto";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PostgresSnapshotStore } from "./postgres-snapshot-store.ts";
import { projects, users } from "./schema.ts";

/**
 * Against a real Postgres: the ordering of "the newest snapshot" is a question only a
 * database answers, and the container is shared across the `db` project, so every test seeds
 * its own project and asserts only on that one.
 */

let sql: postgres.Sql;
let db: PostgresJsDatabase;
let store: PostgresSnapshotStore;

beforeAll(() => {
  sql = postgres(inject("postgresUrl"), { max: 4 });
  db = drizzle(sql);
  store = new PostgresSnapshotStore(db);
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

describe("record", () => {
  it("writes down where the bundle went and what it captured", async () => {
    const projectId = await seedProject();

    const written = await store.record({ projectId, key: "projects/p/1.bundle", gitSha: "abc123" });

    expect(written).toMatchObject({
      projectId,
      key: "projects/p/1.bundle",
      gitSha: "abc123",
    });
    expect(written.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps older snapshots rather than replacing them", async () => {
    const projectId = await seedProject();

    await store.record({ projectId, key: "one", gitSha: "aaa" });
    await store.record({ projectId, key: "two", gitSha: "bbb" });

    expect(await store.listFor(projectId)).toHaveLength(2);
  });
});

describe("latestFor", () => {
  it("is the most recent snapshot", async () => {
    const projectId = await seedProject();
    await store.record({ projectId, key: "older", gitSha: "aaa" });
    const newest = await store.record({ projectId, key: "newer", gitSha: "bbb" });

    await expect(store.latestFor(projectId)).resolves.toMatchObject({
      id: newest.id,
      key: "newer",
    });
  });

  it("breaks a tie deterministically rather than at the planner's discretion", async () => {
    // Two teardowns can land in the same millisecond. Without a tiebreak, "restore the newest"
    // would restore an arbitrary one of them — intermittently, and only under load.
    const projectId = await seedProject();
    const written = await Promise.all([
      store.record({ projectId, key: "a", gitSha: "aaa" }),
      store.record({ projectId, key: "b", gitSha: "bbb" }),
      store.record({ projectId, key: "c", gitSha: "ccc" }),
    ]);

    const first = await store.latestFor(projectId);
    const second = await store.latestFor(projectId);

    expect(first?.id).toBe(second?.id);
    expect(written.map((row) => row.id)).toContain(first?.id);
  });

  it("is null for a project that has never been torn down", async () => {
    await expect(store.latestFor(await seedProject())).resolves.toBeNull();
  });
});

describe("listFor", () => {
  it("returns newest first, so a caller can trust the order", async () => {
    const projectId = await seedProject();
    await store.record({ projectId, key: "older", gitSha: "aaa" });
    await store.record({ projectId, key: "newer", gitSha: "bbb" });

    const listed = await store.listFor(projectId);

    expect(listed.map((row) => row.key)).toEqual(["newer", "older"]);
  });

  it("only lists that project's snapshots", async () => {
    // Project deletion removes objects using exactly this list. Returning somebody else's key
    // would delete a bundle belonging to a project that still exists.
    const mine = await seedProject();
    const theirs = await seedProject();
    await store.record({ projectId: mine, key: "mine", gitSha: "aaa" });
    await store.record({ projectId: theirs, key: "theirs", gitSha: "bbb" });

    expect((await store.listFor(mine)).map((row) => row.key)).toEqual(["mine"]);
  });

  it("is empty for a project with no snapshots", async () => {
    await expect(store.listFor(await seedProject())).resolves.toEqual([]);
  });
});
