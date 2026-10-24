import { randomUUID } from "node:crypto";
import { PostgresProviderAccountStore } from "@nap/db/postgres-provider-account-store";
import { authSessions, users } from "@nap/db/schema";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it, vi } from "vitest";
import { encryptionKeyFrom } from "../account/secret-box.ts";
import { type BrowserAuthDriver, BrowserProviderSignIn } from "./browser-sign-in.ts";
import { ProviderSecretBox } from "./secret-box.ts";

let sql: postgres.Sql;
let db: PostgresJsDatabase;
let store: PostgresProviderAccountStore;
const secrets = new ProviderSecretBox(encryptionKeyFrom(Buffer.alloc(32, 17).toString("base64")));
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
  const [session] = await db
    .insert(authSessions)
    .values({ userId: user.id, token: randomUUID(), expiresAt: new Date(Date.now() + 60_000) })
    .returning();
  if (!session) throw new Error("No test session");
  const account = await store.create({ userId: user.id, driver: "codex", label: null });
  const actor = { userId: user.id, authSessionId: session.id };
  const driver = {
    begin: vi.fn<BrowserAuthDriver["begin"]>(async ({ challenge }) => ({
      ok: true,
      value: {
        url: `https://provider.example/authorize?state=${challenge}`,
        state: "private-pkce-and-nonce",
      },
    })),
    challenge: (redirect: string) => {
      const url = new URL(redirect);
      return url.origin === "https://nap.example" &&
        url.pathname === "/callback" &&
        url.searchParams.getAll("state").length === 1
        ? url.searchParams.get("state")
        : null;
    },
    verify: vi.fn<BrowserAuthDriver["verify"]>(async ({ state }) => {
      expect(state).toBe("private-pkce-and-nonce");
      return {
        ok: true,
        value: {
          credentials: "private-refresh-grant",
          identity: { email: "verified@example.com", plan: null },
        },
      };
    }),
  } satisfies BrowserAuthDriver;
  const runner = () =>
    new BrowserProviderSignIn({
      accounts: store,
      attempts: store,
      secrets,
      drivers: new Map([["codex", driver]]),
    });
  return { actor, account, driver, runner };
}

it("restores an owned browser flow and commits only the verified provider identity and sealed grant", async () => {
  const f = await fixture();
  const start = await f.runner().start(f.actor, f.account);
  expect(start.ok).toBe(true);
  if (!start.ok) throw new Error("No fixture flow");
  const started = start.value;
  expect(started).toMatchObject({ phase: "waiting", interaction: { type: "browser" } });
  expect(JSON.stringify(started)).not.toContain("private-pkce");
  if (started.interaction?.type !== "browser") throw new Error("No browser challenge");
  const challenge = new URL(started.interaction.url).searchParams.get("state");
  const runner = f.runner();
  expect(await runner.current(f.actor, f.account)).toEqual(started);
  const result = await runner.complete(f.actor, f.account, {
    flowId: started.flowId,
    redirect: `https://nap.example/callback?code=one-use&state=${challenge}`,
  });
  expect(result).toMatchObject({ ok: true, value: { phase: "succeeded", interaction: null } });
  expect(f.driver.verify).toHaveBeenCalledOnce();
  const grant = await store.authorization(f.actor.userId, f.account.id);
  expect(grant?.kind).toBe("connected");
  if (grant?.kind !== "connected") throw new Error("No verified grant");
  expect(
    secrets.open(
      {
        kind: "authorization",
        userId: f.actor.userId,
        accountId: f.account.id,
        driver: "codex",
        generation: grant.generation,
      },
      grant.credentials,
    ),
  ).toEqual({ ok: true, value: "private-refresh-grant" });
  expect((await store.get(f.actor.userId, f.account.id))?.auth).toEqual({
    status: "authenticated",
    email: "verified@example.com",
    plan: null,
  });
  expect(JSON.stringify(await runner.current(f.actor, f.account))).not.toContain(
    "private-refresh-grant",
  );
});

it("does not expose or exchange another browser's callback, then consumes a valid callback once across workers", async () => {
  const f = await fixture();
  const start = await f.runner().start(f.actor, f.account);
  if (!start.ok || start.value.interaction?.type !== "browser") throw new Error("No fixture flow");
  const challenge = new URL(start.value.interaction.url).searchParams.get("state");
  const input = {
    flowId: start.value.flowId,
    redirect: `https://nap.example/callback?code=one-use&state=${challenge}`,
  };
  const [otherSession] = await db
    .insert(authSessions)
    .values({
      userId: f.actor.userId,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning();
  if (!otherSession) throw new Error("No second browser session");
  const other = { ...f.actor, authSessionId: otherSession.id };
  expect(await f.runner().current(other, f.account)).toBeNull();
  expect(await f.runner().complete(other, f.account, input)).toEqual({
    ok: false,
    error: { code: "missing" },
  });
  expect(
    await f.runner().complete(f.actor, f.account, {
      ...input,
      redirect: input.redirect.replace("nap.example", "evil.example"),
    }),
  ).toEqual({ ok: false, error: { code: "invalid_callback" } });
  expect(
    await f.runner().complete(f.actor, f.account, {
      ...input,
      redirect: input.redirect.replace(String(challenge), "a".repeat(64)),
    }),
  ).toEqual({ ok: false, error: { code: "stale" } });
  expect(f.driver.verify).not.toHaveBeenCalled();
  const results = await Promise.all(
    Array.from({ length: 4 }, () => f.runner().complete(f.actor, f.account, input)),
  );
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(f.driver.verify).toHaveBeenCalledOnce();
  expect(await f.runner().complete(f.actor, f.account, input)).toEqual({
    ok: false,
    error: { code: "stale" },
  });
});

it("cannot save a grant when logout wins during provider verification", async () => {
  const f = await fixture();
  const start = await f.runner().start(f.actor, f.account);
  if (!start.ok || start.value.interaction?.type !== "browser") throw new Error("No fixture flow");
  const challenge = new URL(start.value.interaction.url).searchParams.get("state");
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.driver.verify.mockImplementationOnce(async () => {
    await waiting;
    return {
      ok: true,
      value: {
        credentials: "late-private-grant",
        identity: { email: "late@example.com", plan: null },
      },
    };
  });
  const completing = f.runner().complete(f.actor, f.account, {
    flowId: start.value.flowId,
    redirect: `https://nap.example/callback?code=one-use&state=${challenge}`,
  });
  await vi.waitFor(() => expect(f.driver.verify).toHaveBeenCalledOnce());
  await store.revokeAuthorization(f.actor.userId, f.account.id);
  release();
  expect(await completing).toEqual({ ok: false, error: { code: "stale" } });
  expect(await store.authorization(f.actor.userId, f.account.id)).toMatchObject({
    kind: "disconnected",
    generation: 1,
  });
  expect((await f.runner().current(f.actor, f.account))?.phase).toBe("cancelled");
});

it("redacts provider failures and never replays an uncertain token exchange", async () => {
  const f = await fixture();
  const start = await f.runner().start(f.actor, f.account);
  if (!start.ok || start.value.interaction?.type !== "browser") throw new Error("No fixture flow");
  const challenge = new URL(start.value.interaction.url).searchParams.get("state");
  const input = {
    flowId: start.value.flowId,
    redirect: `https://nap.example/callback?code=one-use&state=${challenge}`,
  };
  f.driver.verify.mockRejectedValueOnce(
    new Error("lost provider response with private-refresh-grant"),
  );
  const failed = await f.runner().complete(f.actor, f.account, input);
  expect(failed).toMatchObject({
    ok: true,
    value: {
      phase: "failed",
      interaction: null,
      message: "The provider could not be reached. Start again.",
    },
  });
  expect(JSON.stringify(failed)).not.toContain("private-refresh-grant");
  expect(await f.runner().complete(f.actor, f.account, input)).toEqual({
    ok: false,
    error: { code: "stale" },
  });
  expect(f.driver.verify).toHaveBeenCalledOnce();
  expect((await store.authorization(f.actor.userId, f.account.id))?.kind).toBe("disconnected");
});

it("does not start a provider for expired Nap sessions, disabled accounts or an unconfigured driver", async () => {
  const f = await fixture();
  const missing = await f.runner().start({ ...f.actor, authSessionId: randomUUID() }, f.account);
  expect(missing).toEqual({ ok: false, error: { code: "missing" } });
  expect(f.driver.begin).not.toHaveBeenCalled();
  const claude = await store.create({ userId: f.actor.userId, driver: "claude", label: null });
  expect(await f.runner().start(f.actor, claude)).toEqual({
    ok: false,
    error: { code: "unavailable" },
  });
  await store.update(f.actor.userId, f.account.id, { enabled: false });
  expect(await f.runner().start(f.actor, f.account)).toEqual({
    ok: false,
    error: { code: "disabled" },
  });
  expect(f.driver.begin).not.toHaveBeenCalled();
});

it("bounds an unresponsive provider by the original flow deadline even when the adapter ignores abort", async () => {
  const f = await fixture();
  const start = await f.runner().start(f.actor, f.account);
  if (!start.ok || start.value.interaction?.type !== "browser") throw new Error("No fixture flow");
  const challenge = new URL(start.value.interaction.url).searchParams.get("state");
  await sql`update provider_sign_in_attempts set expires_at = clock_timestamp() + interval '1 second' where id = ${start.value.flowId}`;
  f.driver.verify.mockImplementationOnce(() => new Promise(() => {}));
  const result = await f.runner().complete(f.actor, f.account, {
    flowId: start.value.flowId,
    redirect: `https://nap.example/callback?code=one-use&state=${challenge}`,
  });
  expect(result).toEqual({ ok: false, error: { code: "expired" } });
  expect(f.driver.verify).toHaveBeenCalledOnce();
  expect((await f.runner().current(f.actor, f.account))?.phase).toBe("failed");
  expect((await store.authorization(f.actor.userId, f.account.id))?.kind).toBe("disconnected");
});
