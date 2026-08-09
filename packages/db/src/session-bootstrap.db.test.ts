import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PostgresSessionStore } from "./postgres-session-store.ts";
import { projects, users } from "./schema.ts";
import { createProjectSession, DEV_USER_EMAIL } from "./session-bootstrap.ts";

/**
 * Against a real Postgres, because everything worth checking here is a constraint the
 * database owns: the unique index on a user's email, the unique `(user_id, slug)` on
 * projects, and the two foreign keys a session hangs from.
 */

let sql: postgres.Sql;
let db: PostgresJsDatabase;

beforeAll(() => {
  sql = postgres(inject("postgresUrl"), { max: 4 });
  db = drizzle(sql);
});

afterAll(async () => {
  await sql.end();
});

describe("createProjectSession", () => {
  it("produces a session the session store can resolve", async () => {
    // The point of the whole endpoint: something the rest of the app can immediately use.
    const created = await createProjectSession(db, { name: "Todo app" });

    await expect(new PostgresSessionStore(db).get(created.sessionId)).resolves.toEqual({
      sessionId: created.sessionId,
      projectId: created.projectId,
      sandboxId: null,
    });
  });

  it("reuses the one dev user rather than making another", async () => {
    // The unique index on email would reject a second insert outright, so this is not a
    // preference — it is the difference between the endpoint working twice and working once.
    const first = await createProjectSession(db, { name: "First" });
    const second = await createProjectSession(db, { name: "Second" });

    const owners = await db
      .select({ userId: projects.userId })
      .from(projects)
      .where(eq(projects.id, first.projectId));
    const others = await db
      .select({ userId: projects.userId })
      .from(projects)
      .where(eq(projects.id, second.projectId));

    expect(owners[0]?.userId).toBe(others[0]?.userId);
    expect(await db.select().from(users).where(eq(users.email, DEV_USER_EMAIL))).toHaveLength(1);
  });

  it("gives every project its own slug", async () => {
    // `(user_id, slug)` is unique, and every project here belongs to the same user — so a
    // slug derived from the name alone fails on the second project called "Todo app".
    const first = await createProjectSession(db, { name: "Todo app" });
    const second = await createProjectSession(db, { name: "Todo app" });

    expect(first.projectId).not.toBe(second.projectId);
  });

  it("starts a project with no sandbox", async () => {
    // The first turn creates one. A project that claimed a sandbox before it had one would
    // make the runtime try to resume something that never existed.
    const created = await createProjectSession(db, { name: "Fresh" });

    const [project] = await db.select().from(projects).where(eq(projects.id, created.projectId));

    expect(project?.sandboxId).toBeNull();
    expect(project?.status).toBe("creating");
  });
});
