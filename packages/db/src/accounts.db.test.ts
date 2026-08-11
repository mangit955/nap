/**
 * That `accounts` really refuses two rows for the same provider account.
 *
 * This exists because the obvious test does not cover it. Signing in with the same GitHub
 * account twice produces one user whether or not the constraint is there — the auth library
 * looks the row up before inserting, so the ordinary path never reaches the index. Dropping
 * the constraint leaves every sign-in test green, which was checked by doing it.
 *
 * What the index is for is the race that lookup cannot win: two callbacks for one account
 * arriving together, both finding nothing, both inserting. That is not something a test can
 * stage reliably, so what is asserted instead is that the guard exists and bites — the same
 * reasoning that put a test on `unique(session_id, seq)` in the event store.
 *
 * On the SQLSTATE rather than the message: drizzle wraps the error, so `.message` is
 * "Failed query: …" and the real reason is on `.cause`.
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { accounts, users } from "./schema.ts";

let sql: postgres.Sql;
let db: PostgresJsDatabase;
let userId: string;

beforeAll(async () => {
  sql = postgres(inject("postgresUrl"), { max: 4 });
  db = drizzle(sql);

  const [person] = await db
    .insert(users)
    .values({ email: `accounts-${crypto.randomUUID()}@example.com`, name: "Test" })
    .returning({ id: users.id });
  if (person === undefined) throw new Error("insert into users returned no row");
  userId = person.id;
});

afterAll(async () => {
  await sql.end();
});

it("refuses a second row for the same provider account", async () => {
  // Unique per run: the container is shared, so a fixed id would collide with the last run
  // rather than with this test's own first insert.
  const accountId = `github-${crypto.randomUUID()}`;

  await db.insert(accounts).values({ userId, providerId: "github", accountId });

  const duplicate = db.insert(accounts).values({ userId, providerId: "github", accountId });

  await expect(duplicate).rejects.toMatchObject({ cause: { code: "23505" } });
});

it("allows the same account id from a different provider", async () => {
  // Provider ids are only unique within a provider — GitHub user 42 and some other service's
  // user 42 are different people, and a constraint on `account_id` alone would conflate them.
  const accountId = `shared-${crypto.randomUUID()}`;

  await db.insert(accounts).values({ userId, providerId: "github", accountId });
  const other = db.insert(accounts).values({ userId, providerId: "gitlab", accountId });

  await expect(other).resolves.toBeDefined();
});
