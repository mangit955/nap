import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PostgresSessionStore } from "./postgres-session-store.ts";
import { projects, users } from "./schema.ts";
import { createProjectSession } from "./session-bootstrap.ts";

/**
 * Against a real Postgres, because everything worth checking here is a constraint the
 * database owns: the unique index on a user's email, the unique `(user_id, slug)` on
 * projects, and the two foreign keys a session hangs from.
 */

let sql: postgres.Sql;
let db: PostgresJsDatabase;
/** A real signed-in user stands in for the caller; this function no longer invents one. */
let owner: string;

beforeAll(async () => {
  sql = postgres(inject("postgresUrl"), { max: 4 });
  db = drizzle(sql);
  const [user] = await db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@example.com`, name: "Ada" })
    .returning();
  owner = user?.id ?? "";
});

afterAll(async () => {
  await sql.end();
});

describe("createProjectSession", () => {
  it("produces a session the session store can resolve", async () => {
    // The point of the whole endpoint: something the rest of the app can immediately use.
    const created = await createProjectSession(db, { userId: owner, name: "Todo app" });

    await expect(new PostgresSessionStore(db).get(created.sessionId)).resolves.toEqual({
      sessionId: created.sessionId,
      projectId: created.projectId,
      // Carried down from the project, which is what every session-addressed route authorizes on.
      userId: owner,
      sandboxId: null,
    });
  });

  it("gives every project to the caller, and creates no users of its own", async () => {
    // It used to find-or-create a fixed `dev@nap.local`. Nothing here makes a user any more:
    // a project's owner is whoever asked for it, and inventing identities as a side effect of
    // creating a project is how you end up with two identity tables.
    const before = await db.select().from(users);

    const first = await createProjectSession(db, { userId: owner, name: "First" });
    const second = await createProjectSession(db, { userId: owner, name: "Second" });

    for (const created of [first, second]) {
      const [project] = await db
        .select({ userId: projects.userId })
        .from(projects)
        .where(eq(projects.id, created.projectId));
      expect(project?.userId).toBe(owner);
    }
    expect(await db.select().from(users)).toHaveLength(before.length);
  });

  it("gives every project its own slug", async () => {
    // `(user_id, slug)` is unique and both of these belong to the same user, so a slug
    // derived from the name alone fails on the second project called "Todo app".
    const first = await createProjectSession(db, { userId: owner, name: "Todo app" });
    const second = await createProjectSession(db, { userId: owner, name: "Todo app" });

    expect(first.projectId).not.toBe(second.projectId);
  });

  it("starts a project with no sandbox", async () => {
    // The first turn creates one. A project that claimed a sandbox before it had one would
    // make the runtime try to resume something that never existed.
    const created = await createProjectSession(db, { userId: owner, name: "Fresh" });

    const [project] = await db.select().from(projects).where(eq(projects.id, created.projectId));

    expect(project?.sandboxId).toBeNull();
    expect(project?.status).toBe("creating");
  });
});
