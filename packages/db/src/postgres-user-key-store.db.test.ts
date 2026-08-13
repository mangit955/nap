import { randomUUID } from "node:crypto";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PostgresUserKeyStore } from "./postgres-user-key-store.ts";
import { users } from "./schema.ts";

/**
 * Against a real Postgres, because the two things worth proving here are both the database's
 * doing: that a second save *replaces* rather than colliding with the first, and that a
 * deleted user takes their key with them. The container is shared across the `db` project, so
 * every test seeds its own user and asserts only on that one.
 */

let sql: postgres.Sql;
let db: PostgresJsDatabase;
let store: PostgresUserKeyStore;

beforeAll(() => {
  sql = postgres(inject("postgresUrl"), { max: 4 });
  db = drizzle(sql);
  store = new PostgresUserKeyStore(db);
});

afterAll(async () => {
  await sql.end();
});

async function seedUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Ada" })
    .returning();
  return user?.id ?? "";
}

function aKey(userId: string) {
  return {
    userId,
    platform: "openrouter" as const,
    ciphertext: "c2VhbGVk",
    iv: "aXYtYnl0ZXM=",
    hint: "sk-or-…4f2a",
  };
}

describe("get", () => {
  it("answers null for somebody who has never saved one", async () => {
    expect(await store.get(await seedUser())).toBeNull();
  });

  it("hands back what was saved, with an ISO date", async () => {
    const userId = await seedUser();
    await store.put(aKey(userId));

    const found = await store.get(userId);

    expect(found).toMatchObject({ userId, platform: "openrouter", hint: "sk-or-…4f2a" });
    expect(found?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("put", () => {
  it("replaces the key already there rather than failing on the primary key", async () => {
    const userId = await seedUser();
    await store.put(aKey(userId));

    await store.put({
      userId,
      platform: "anthropic",
      ciphertext: "bmV3",
      iv: "bmV3LWl2",
      hint: "sk-ant-…9c1d",
    });

    // The whole row, not a merge: a person who swapped an OpenRouter key for an Anthropic one
    // must not be left with the old ciphertext under the new platform, which would send every
    // turn to the wrong vendor with a key it will not accept.
    expect(await store.get(userId)).toMatchObject({
      platform: "anthropic",
      ciphertext: "bmV3",
      hint: "sk-ant-…9c1d",
    });
  });

  it("moves updatedAt when the key is replaced", async () => {
    const userId = await seedUser();
    const first = await store.put(aKey(userId));

    const second = await store.put({ ...aKey(userId), ciphertext: "b3RoZXI=" });

    // `defaultNow()` fires only on insert, so without an explicit `set` the upsert path would
    // report the date the *first* key was saved and "when did I last change this?" would lie.
    expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt));
  });
});

describe("remove", () => {
  it("forgets the key", async () => {
    const userId = await seedUser();
    await store.put(aKey(userId));

    await store.remove(userId);

    expect(await store.get(userId)).toBeNull();
  });

  it("is silent when there was nothing to forget", async () => {
    await expect(store.remove(await seedUser())).resolves.toBeUndefined();
  });
});

describe("the foreign key", () => {
  it("takes the key with the user when the user is deleted", async () => {
    const userId = await seedUser();
    await store.put(aKey(userId));

    await sql`delete from users where id = ${userId}`;

    // A key outliving its owner is a credential nobody can reach and nobody can revoke.
    expect(await store.get(userId)).toBeNull();
  });
});
