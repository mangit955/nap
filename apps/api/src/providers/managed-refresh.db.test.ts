import { randomUUID } from "node:crypto";
import { PostgresProviderAccountStore } from "@nap/db/postgres-provider-account-store";
import { users } from "@nap/db/schema";
import type { SubscriptionTarget } from "@nap/shared/execution-target";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it, vi } from "vitest";
import { encryptionKeyFrom } from "../account/secret-box.ts";
import { ManagedProviderRefresh, type ManagedRefreshDriver } from "./managed-refresh.ts";
import { ProviderSecretBox } from "./secret-box.ts";

let sql: postgres.Sql;
let db: PostgresJsDatabase;
let store: PostgresProviderAccountStore;
const secrets = new ProviderSecretBox(encryptionKeyFrom(Buffer.alloc(32, 19).toString("base64")));
beforeAll(() => {
  sql = postgres(inject("postgresUrl"), { max: 8 });
  db = drizzle(sql);
  store = new PostgresProviderAccountStore(db);
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
  const account = await store.create({ userId: user.id, driver: "codex", label: null });
  const scope = {
    kind: "authorization",
    userId: user.id,
    accountId: account.id,
    driver: "codex",
    generation: 1,
  } as const;
  await store.completeSignIn(user.id, account.id, {
    generation: 0,
    credentials: secrets.seal(scope, "private-old-refresh-token"),
    identity: { email: "verified@example.com", plan: null },
  });
  const target: SubscriptionTarget = {
    kind: "subscription",
    accountId: account.id,
    driver: "codex",
    model: "offline-fixture-model",
    generation: 1,
  };
  const driver = {
    refresh: vi.fn<ManagedRefreshDriver["refresh"]>(async ({ credentials }) => {
      expect(credentials).toBe("private-old-refresh-token");
      return { ok: true, value: "private-next-refresh-token" };
    }),
  } satisfies ManagedRefreshDriver;
  const coordinator = (requestTimeoutMs = 20_000) =>
    new ManagedProviderRefresh({
      accounts: store,
      refreshes: store,
      secrets,
      drivers: new Map([["codex", driver]]),
      requestTimeoutMs,
    });
  return { userId: user.id, target, driver, coordinator, scope };
}

it("uses the distributed claim to refresh and reseal one account without returning tokens", async () => {
  const f = await fixture();
  expect(await f.coordinator().refresh(f.userId, f.target)).toEqual({
    ok: true,
    value: { generation: 1, version: 2 },
  });
  expect(f.driver.refresh).toHaveBeenCalledOnce();
  const authorization = await store.authorization(f.userId, f.target.accountId);
  if (authorization?.kind !== "connected") throw new Error("No refreshed authorization");
  expect(secrets.open(f.scope, authorization.credentials)).toEqual({
    ok: true,
    value: "private-next-refresh-token",
  });
});

it("keeps one exchange owner across coordinator instances", async () => {
  const f = await fixture();
  const pending = Promise.withResolvers<void>();
  f.driver.refresh.mockImplementationOnce(async () => {
    await pending.promise;
    return { ok: true, value: "private-next-refresh-token" };
  });
  const first = f.coordinator().refresh(f.userId, f.target);
  await vi.waitFor(() => expect(f.driver.refresh).toHaveBeenCalledOnce());
  const competitors = await Promise.all(
    Array.from({ length: 4 }, () => f.coordinator().refresh(f.userId, f.target)),
  );
  expect(competitors).toEqual(
    Array.from({ length: 4 }, () => ({ ok: false, error: { code: "busy" } })),
  );
  pending.resolve();
  expect(await first).toEqual({ ok: true, value: { generation: 1, version: 2 } });
  expect(f.driver.refresh).toHaveBeenCalledOnce();
});

it("requires reconnect after a lost response and ignores a late provider result", async () => {
  const f = await fixture();
  const pending = Promise.withResolvers<Awaited<ReturnType<ManagedRefreshDriver["refresh"]>>>();
  f.driver.refresh.mockImplementationOnce(() => pending.promise);
  const result = await f.coordinator(20).refresh(f.userId, f.target);
  expect(result).toEqual({ ok: false, error: { code: "reconnect_required" } });
  pending.resolve({ ok: true, value: "late-private-refresh-token" });
  await pending.promise;
  expect(await f.coordinator().refresh(f.userId, f.target)).toEqual({
    ok: false,
    error: { code: "reconnect_required" },
  });
  expect(f.driver.refresh).toHaveBeenCalledOnce();
  expect(await store.authorization(f.userId, f.target.accountId)).toMatchObject({
    kind: "reconnect_required",
    generation: 2,
  });
});

it("fences a completed provider refresh after account logout", async () => {
  const f = await fixture();
  const pending = Promise.withResolvers<void>();
  f.driver.refresh.mockImplementationOnce(async () => {
    await pending.promise;
    return { ok: true, value: "late-private-refresh-token" };
  });
  const first = f.coordinator().refresh(f.userId, f.target);
  await vi.waitFor(() => expect(f.driver.refresh).toHaveBeenCalledOnce());
  await store.revokeAuthorization(f.userId, f.target.accountId);
  pending.resolve();
  expect(await first).toEqual({ ok: false, error: { code: "stale" } });
  expect(await store.authorization(f.userId, f.target.accountId)).toMatchObject({
    kind: "disconnected",
    generation: 2,
  });
});

it("refuses ciphertext from a different account before contacting the provider", async () => {
  const f = await fixture();
  await store.replaceCredentials(f.userId, f.target.accountId, {
    generation: 1,
    version: 1,
    credentials: secrets.seal(
      { ...f.scope, accountId: randomUUID() },
      "other-account-private-token",
    ),
  });
  expect(await f.coordinator().refresh(f.userId, f.target)).toEqual({
    ok: false,
    error: { code: "reconnect_required" },
  });
  expect(f.driver.refresh).not.toHaveBeenCalled();
});
