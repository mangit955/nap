import { randomUUID } from "node:crypto";
import { ProviderRefreshClaimTokenSchema } from "@nap/shared/ports/provider-refresh-store";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { PostgresProviderAccountStore } from "./postgres-provider-account-store.ts";
import { users } from "./schema.ts";

let sql: postgres.Sql;
let db: PostgresJsDatabase;
let store: PostgresProviderAccountStore;
beforeAll(() => {
  sql = postgres(inject("postgresUrl"), { max: 8 });
  db = drizzle(sql);
  store = new PostgresProviderAccountStore(db);
});
afterAll(async () => {
  await sql.end();
});
const OLD = { ciphertext: "sealed-old-refresh-grant", iv: "old-iv" };
const NEXT = { ciphertext: "sealed-next-refresh-grant", iv: "next-iv" };
async function fixture() {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Ada", isAnonymous: false })
    .returning();
  if (!user) throw new Error("No test user");
  const account = await store.create({ userId: user.id, driver: "codex", label: null });
  await store.completeSignIn(user.id, account.id, {
    generation: 0,
    credentials: OLD,
    identity: { email: "verified@example.com", plan: null },
  });
  return { userId: user.id, accountId: account.id, generation: 1, version: 1 };
}

it("gives one refresh worker the sealed grant and hides it until that worker commits", async () => {
  const revision = await fixture();
  const claim = await store.claimManagedRefresh(revision);
  expect(claim).toMatchObject({ kind: "claimed", credentials: OLD });
  if (claim.kind !== "claimed") throw new Error("No refresh claim");
  const restarted = new PostgresProviderAccountStore(db);
  const busy = await restarted.authorization(revision.userId, revision.accountId);
  expect(busy).toMatchObject({ kind: "refreshing", generation: 1, version: 1 });
  expect(JSON.stringify(busy)).not.toContain("sealed-old-refresh-grant");
  expect(await restarted.claimManagedRefresh(revision)).toEqual({ kind: "busy" });
  const finished = await restarted.finishManagedRefresh({
    ...revision,
    claimToken: claim.claimToken,
    outcome: { kind: "renewed", credentials: NEXT },
  });
  expect(finished).toMatchObject({
    kind: "updated",
    authorization: { kind: "connected", generation: 1, version: 2, credentials: NEXT },
  });
  expect(await store.authorization(revision.userId, revision.accountId)).toMatchObject({
    kind: "connected",
    generation: 1,
    version: 2,
    credentials: NEXT,
  });
  expect(
    await store.finishManagedRefresh({
      ...revision,
      claimToken: claim.claimToken,
      outcome: { kind: "renewed", credentials: OLD },
    }),
  ).toEqual({ kind: "stale" });
});

it("admits one worker across a refresh race and refuses guessed completion tokens", async () => {
  const revision = await fixture();
  const claims = await Promise.all(
    Array.from({ length: 6 }, () =>
      new PostgresProviderAccountStore(db).claimManagedRefresh(revision),
    ),
  );
  expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
  expect(claims.filter((claim) => claim.kind === "busy")).toHaveLength(5);
  const claim = claims.find((candidate) => candidate.kind === "claimed");
  if (claim?.kind !== "claimed") throw new Error("No winning worker");
  expect(
    await store.finishManagedRefresh({
      ...revision,
      claimToken: ProviderRefreshClaimTokenSchema.parse("a".repeat(64)),
      outcome: { kind: "renewed", credentials: NEXT },
    }),
  ).toEqual({ kind: "stale" });
  expect(await store.claimManagedRefresh({ ...revision, version: 0 })).toEqual({ kind: "stale" });
  expect(await store.claimManagedRefresh({ ...revision, userId: randomUUID() })).toEqual({
    kind: "missing",
  });
  const rows =
    await sql`select claim_token_hash from provider_credential_refreshes where account_id = ${revision.accountId}`;
  expect(rows[0]?.claim_token_hash).not.toBe(claim.claimToken);
  expect(rows[0]?.claim_token_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(
    await store.finishManagedRefresh({
      ...revision,
      claimToken: claim.claimToken,
      outcome: { kind: "renewed", credentials: NEXT },
    }),
  ).toMatchObject({ kind: "updated" });
});

it.each(["expired", "uncertain"])(
  "requires reconnection after %s refresh, never taking over or replaying the old grant",
  async (mode) => {
    const revision = await fixture();
    const claim = await store.claimManagedRefresh(revision);
    if (claim.kind !== "claimed") throw new Error("No refresh claim");
    if (mode === "expired") {
      await sql`update provider_credential_refreshes set created_at = clock_timestamp() - interval '1 minute', expires_at = clock_timestamp() - interval '1 second' where account_id = ${revision.accountId}`;
    } else {
      expect(
        await store.finishManagedRefresh({
          ...revision,
          claimToken: claim.claimToken,
          outcome: { kind: "uncertain" },
        }),
      ).toMatchObject({ kind: "updated", authorization: { kind: "reconnect_required" } });
    }
    const restarted = new PostgresProviderAccountStore(db);
    expect(await restarted.authorization(revision.userId, revision.accountId)).toEqual({
      kind: "reconnect_required",
      generation: 2,
      version: 2,
      reason: "refresh_uncertain",
    });
    expect(await restarted.claimManagedRefresh({ ...revision, generation: 2, version: 2 })).toEqual(
      { kind: "reconnect_required" },
    );
    expect(
      await restarted.finishManagedRefresh({
        ...revision,
        claimToken: claim.claimToken,
        outcome: { kind: "renewed", credentials: NEXT },
      }),
    ).toEqual({ kind: "stale" });
    expect((await store.get(revision.userId, revision.accountId))?.auth.status).toBe("expired");
    const rows =
      await sql`select ciphertext, iv from provider_credentials where account_id = ${revision.accountId}`;
    expect(rows[0]).toMatchObject({ ciphertext: null, iv: null });
    const login = await store.completeSignIn(revision.userId, revision.accountId, {
      generation: 2,
      credentials: NEXT,
      identity: { email: "reconnected@example.com", plan: null },
    });
    expect(login).toMatchObject({
      kind: "updated",
      authorization: { kind: "connected", generation: 3, version: 3 },
    });
    expect(
      await store.claimManagedRefresh({ ...revision, generation: 3, version: 3 }),
    ).toMatchObject({ kind: "claimed", credentials: NEXT });
  },
);

it.each(["logout", "disable", "new_login", "remove"])(
  "fences a refresh result after %s",
  async (action) => {
    const revision = await fixture();
    const claim = await store.claimManagedRefresh(revision);
    if (claim.kind !== "claimed") throw new Error("No refresh claim");
    if (action === "logout") await store.revokeAuthorization(revision.userId, revision.accountId);
    if (action === "disable")
      await store.update(revision.userId, revision.accountId, { enabled: false });
    if (action === "remove") await store.remove(revision.userId, revision.accountId);
    if (action === "new_login")
      await store.completeSignIn(revision.userId, revision.accountId, {
        generation: 1,
        credentials: NEXT,
        identity: { email: "new@example.com", plan: null },
      });
    expect(
      await store.finishManagedRefresh({
        ...revision,
        claimToken: claim.claimToken,
        outcome: { kind: "renewed", credentials: OLD },
      }),
    ).toEqual({
      kind: action === "disable" ? "disabled" : action === "remove" ? "missing" : "stale",
    });
  },
);

it("prevents low-level CAS from bypassing a managed refresh claim", async () => {
  const revision = await fixture();
  expect((await store.claimManagedRefresh(revision)).kind).toBe("claimed");
  expect(
    await store.replaceCredentials(revision.userId, revision.accountId, {
      generation: 1,
      version: 1,
      credentials: NEXT,
    }),
  ).toEqual({ kind: "stale" });
  expect((await store.authorization(revision.userId, revision.accountId))?.kind).toBe("refreshing");
});

it("rejects invalid managed-refresh rows and cascades private state when the account is deleted", async () => {
  const revision = await fixture();
  await expect(
    sql`insert into provider_credential_refreshes(account_id, phase) values (${revision.accountId}, 'claimed')`,
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    sql`insert into provider_credential_refreshes(account_id, phase, expires_at) values (${revision.accountId}, 'uncertain', clock_timestamp())`,
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    sql`insert into provider_credential_refreshes(account_id, phase) values (${revision.accountId}, 'ready')`,
  ).rejects.toMatchObject({ code: "23514" });
  expect((await store.claimManagedRefresh(revision)).kind).toBe("claimed");
  await expect(
    sql`insert into provider_credential_refreshes(account_id, phase) values (${revision.accountId}, 'uncertain')`,
  ).rejects.toMatchObject({ code: "23505" });
  await store.remove(revision.userId, revision.accountId);
  expect(
    await sql`select * from provider_credential_refreshes where account_id = ${revision.accountId}`,
  ).toHaveLength(0);
});

it("does not give anonymous or disconnected accounts a refresh grant", async () => {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Guest", isAnonymous: true })
    .returning();
  if (!user) throw new Error("No test user");
  const account = await store.create({ userId: user.id, driver: "codex", label: null });
  await store.completeSignIn(user.id, account.id, {
    generation: 0,
    credentials: OLD,
    identity: { email: null, plan: null },
  });
  expect(
    await store.claimManagedRefresh({
      userId: user.id,
      accountId: account.id,
      generation: 1,
      version: 1,
    }),
  ).toEqual({ kind: "missing" });
  const permanent = await fixture();
  await store.revokeAuthorization(permanent.userId, permanent.accountId);
  expect(await store.claimManagedRefresh({ ...permanent, generation: 2, version: 2 })).toEqual({
    kind: "disconnected",
  });
});
