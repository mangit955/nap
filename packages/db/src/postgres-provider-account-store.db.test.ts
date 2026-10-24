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
});
