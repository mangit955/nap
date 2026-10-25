import { randomUUID } from "node:crypto";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PostgresProviderAccountStore } from "./postgres-provider-account-store.ts";
import { users } from "./schema.ts";
import { providerAccountStoreContract } from "./testing/provider-account-store-contract.ts";

/**
 * The shared contract against the real table, plus the one thing only the database can show: a
 * deleted user takes their accounts with them. The container is shared across the `db` project,
 * so every test seeds its own users and asserts only on those.
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

async function seedUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Ada" })
    .returning();
  if (user === undefined) throw new Error("could not seed a user");
  return user.id;
}

providerAccountStoreContract("PostgresProviderAccountStore", () => ({
  store: new PostgresProviderAccountStore(db),
  user: seedUser,
}));

describe("PostgresProviderAccountStore", () => {
  it("forgets a person's accounts when the person is deleted", async () => {
    const store = new PostgresProviderAccountStore(db);
    const owner = await seedUser();
    const account = await store.create({ userId: owner, driver: "claude", label: null });

    await sql`delete from users where id = ${owner}`;

    await expect(store.get(owner, account.id)).resolves.toBeNull();
  });

  it("answers null for an id that is not a uuid, rather than a query error", async () => {
    const store = new PostgresProviderAccountStore(db);
    const owner = await seedUser();

    await expect(store.get(owner, "not-a-uuid")).resolves.toBeNull();
  });
  it("cascades private credentials with their account and enforces sealed pairs", async () => {
    const store = new PostgresProviderAccountStore(db);
    const owner = await seedUser();
    const account = await store.create({ userId: owner, driver: "claude", label: null });
    await expect(
      sql`insert into provider_credentials (account_id, ciphertext) values (${account.id}, 'orphan')`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      sql`insert into provider_credentials (account_id, generation) values (${account.id}, -1)`,
    ).rejects.toMatchObject({ code: "23514" });
    await store.completeSignIn(owner, account.id, {
      generation: 0,
      credentials: { ciphertext: "sealed", iv: "iv" },
      identity: { email: null, plan: null },
    });
    expect(
      await sql`select account_id from provider_credentials where account_id = ${account.id}`,
    ).toHaveLength(1);
    await store.remove(owner, account.id);
    expect(
      await sql`select account_id from provider_credentials where account_id = ${account.id}`,
    ).toHaveLength(0);
  });

  it("serializes disable against a concurrent login and leaves the account disconnected", async () => {
    const store = new PostgresProviderAccountStore(db);
    const owner = await seedUser();
    const account = await store.create({ userId: owner, driver: "claude", label: null });
    await Promise.all([
      store.completeSignIn(owner, account.id, {
        generation: 0,
        credentials: { ciphertext: "sealed", iv: "iv" },
        identity: { email: null, plan: null },
      }),
      store.update(owner, account.id, { enabled: false }),
    ]);
    await expect(store.authorization(owner, account.id)).resolves.toMatchObject({
      kind: "disconnected",
    });
    await expect(store.get(owner, account.id)).resolves.toMatchObject({
      enabled: false,
      auth: { status: "unauthenticated" },
    });
  });
});
