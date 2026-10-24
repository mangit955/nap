import { randomUUID } from "node:crypto";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { PostgresSessionStore } from "./postgres-session-store.ts";
import { projects, sessions, users } from "./schema.ts";

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
async function fixture() {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Ada", isAnonymous: false })
    .returning();
  if (!user) throw new Error("No test user");
  const [project] = await db
    .insert(projects)
    .values({ userId: user.id, name: "Fixture", slug: `fixture-${randomUUID()}` })
    .returning();
  if (!project) throw new Error("No test project");
  const [session] = await db
    .insert(sessions)
    .values({ projectId: project.id, title: "Fixture" })
    .returning();
  if (!session) throw new Error("No test session");
  return { userId: user.id, sessionId: session.id };
}
it("retains an owned subscription selection across processes without embedding authorization", async () => {
  const f = await fixture();
  expect(await store.selection(f.userId, f.sessionId)).toEqual({ selection: null });
  const selection = {
    kind: "subscription",
    accountId: randomUUID(),
    model: "offline-native-fixture",
  } as const;
  expect(await store.select(f.userId, f.sessionId, selection)).toBe(true);
  const restarted = new PostgresSessionStore(db);
  expect(await restarted.selection(f.userId, f.sessionId)).toEqual({ selection });
  expect(await restarted.selection(randomUUID(), f.sessionId)).toBeNull();
  expect(
    await restarted.select(randomUUID(), f.sessionId, { kind: "api", model: "api-fixture" }),
  ).toBe(false);
  expect(await restarted.selection(f.userId, f.sessionId)).toEqual({ selection });
});

it("fails closed on corrupt persisted preferences and refuses missing sessions", async () => {
  const f = await fixture();
  expect(await store.selection(f.userId, randomUUID())).toBeNull();
  expect(await store.select(f.userId, randomUUID(), { kind: "api" })).toBe(false);
  expect(await store.selection(f.userId, "invalid-session")).toBeNull();
  expect(await store.select(f.userId, "invalid-session", { kind: "api" })).toBe(false);
  await sql`update sessions set execution_selection = ${JSON.stringify({ kind: "subscription", generation: 999 })}::jsonb where id = ${f.sessionId}`;
  await expect(store.selection(f.userId, f.sessionId)).rejects.toThrow();
});
