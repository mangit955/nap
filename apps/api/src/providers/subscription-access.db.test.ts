import { randomUUID } from "node:crypto";
import { PostgresProviderAccountStore } from "@nap/db/postgres-provider-account-store";
import { users } from "@nap/db/schema";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { SubscriptionAccess } from "./subscription-access.ts";

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
const MODEL = { id: "offline-native-fixture", label: "Offline native model", supportsImages: true };
async function fixture() {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Ada", isAnonymous: false })
    .returning();
  if (!user) throw new Error("No test user");
  const account = await store.create({ userId: user.id, driver: "claude", label: "Work" });
  await store.completeSignIn(user.id, account.id, {
    generation: 0,
    credentials: { ciphertext: "private-sealed-fixture", iv: "fixture-iv" },
    identity: { email: "verified@example.com", plan: null },
  });
  const access = new SubscriptionAccess({
    accounts: store,
    providers: new Map([["claude", [MODEL]]]),
  });
  const selection = { kind: "subscription", accountId: account.id, model: MODEL.id } as const;
  return { userId: user.id, account, selection, access };
}
it("resolves a selected account against its current authorization without exposing credentials", async () => {
  const f = await fixture();
  const result = await f.access.resolve({
    userId: f.userId,
    selection: f.selection,
    hasImages: true,
  });
  expect(result).toEqual({ ok: true, value: { ...f.selection, driver: "claude", generation: 1 } });
  const catalog = await f.access.catalog(f.userId);
  expect(catalog).toMatchObject({
    accounts: [
      { account: { id: f.account.id, label: "Work" }, models: [MODEL], availability: "ready" },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("private-sealed-fixture");
  expect(JSON.stringify(catalog)).not.toContain("private-sealed-fixture");
});

it("rechecks owner, account state, model capabilities and account generation", async () => {
  const f = await fixture();
  const result = await f.access.resolve({ userId: f.userId, selection: f.selection });
  if (!result.ok) throw new Error("No admitted fixture target");
  expect(await f.access.authorize({ userId: f.userId, target: result.value })).toEqual({
    ok: true,
    value: undefined,
  });
  expect(await f.access.resolve({ userId: randomUUID(), selection: f.selection })).toMatchObject({
    ok: false,
    error: { code: "provider_account_missing" },
  });
  expect(
    await f.access.resolve({
      userId: f.userId,
      selection: { ...f.selection, model: "unconfigured" },
    }),
  ).toMatchObject({ ok: false, error: { code: "model_not_allowed" } });
  const textOnly = new SubscriptionAccess({
    accounts: store,
    providers: new Map([["claude", [{ ...MODEL, supportsImages: false }]]]),
  });
  expect(
    await textOnly.resolve({ userId: f.userId, selection: f.selection, hasImages: true }),
  ).toMatchObject({ ok: false, error: { code: "model_media_unsupported" } });
  await store.revokeAuthorization(f.userId, f.account.id);
  expect(await f.access.authorize({ userId: f.userId, target: result.value })).toMatchObject({
    ok: false,
    error: { code: "provider_sign_in_required" },
  });
  await store.completeSignIn(f.userId, f.account.id, {
    generation: 2,
    credentials: { ciphertext: "sealed-new-grant", iv: "new-iv" },
    identity: { email: "verified@example.com", plan: null },
  });
  expect(await f.access.authorize({ userId: f.userId, target: result.value })).toMatchObject({
    ok: false,
    error: { code: "provider_authentication_changed" },
  });
  await store.update(f.userId, f.account.id, { enabled: false });
  expect(await f.access.resolve({ userId: f.userId, selection: f.selection })).toMatchObject({
    ok: false,
    error: { code: "provider_account_disabled" },
  });
});

it("does not treat public authenticated metadata as an installed runtime or a usable grant", async () => {
  const f = await fixture();
  const unavailable = new SubscriptionAccess({ accounts: store });
  expect(await unavailable.resolve({ userId: f.userId, selection: f.selection })).toMatchObject({
    ok: false,
    error: { code: "subscription_unavailable" },
  });
  expect((await unavailable.catalog(f.userId)).accounts[0]).toMatchObject({
    availability: "unavailable",
    models: [],
  });
  const claim = await store.claimManagedRefresh({
    userId: f.userId,
    accountId: f.account.id,
    generation: 1,
    version: 1,
  });
  if (claim.kind !== "claimed") throw new Error("No managed refresh fixture");
  expect(await f.access.resolve({ userId: f.userId, selection: f.selection })).toMatchObject({
    ok: false,
    error: { code: "provider_refreshing" },
  });
  expect((await f.access.catalog(f.userId)).accounts[0]?.availability).toBe("refreshing");
  const target = {
    kind: "subscription",
    driver: "claude",
    accountId: f.account.id,
    model: MODEL.id,
    generation: 1,
  } as const;
  expect(await f.access.authorize({ userId: f.userId, target, phase: "start" })).toMatchObject({
    ok: false,
    error: { code: "provider_refreshing" },
  });
  expect(await f.access.authorize({ userId: f.userId, target, phase: "continue" })).toEqual({
    ok: true,
    value: undefined,
  });
  await store.finishManagedRefresh({
    userId: f.userId,
    accountId: f.account.id,
    generation: 1,
    version: 1,
    claimToken: claim.claimToken,
    outcome: { kind: "uncertain" },
  });
  expect(await f.access.resolve({ userId: f.userId, selection: f.selection })).toMatchObject({
    ok: false,
    error: { code: "provider_sign_in_required" },
  });
});

it("does not let a catalog reader mutate the installed model policy", async () => {
  const f = await fixture();
  const catalog = await f.access.catalog(f.userId);
  const model = catalog.accounts[0]?.models[0];
  if (!model) throw new Error("No catalog model");
  model.id = "injected-model";
  expect(
    await f.access.resolve({
      userId: f.userId,
      selection: { ...f.selection, model: "injected-model" },
    }),
  ).toMatchObject({ ok: false, error: { code: "model_not_allowed" } });
});
