import { randomUUID } from "node:crypto";
import { PostgresProviderAccountStore } from "@nap/db/postgres-provider-account-store";
import { authSessions, users } from "@nap/db/schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it, vi } from "vitest";
import { encryptionKeyFrom } from "../account/secret-box.ts";
import { ProviderSecretBox } from "./secret-box.ts";
import { type TerminalAuthDriver, TerminalProviderSignIn } from "./terminal-sign-in.ts";

let sql: postgres.Sql;
let store: PostgresProviderAccountStore;
beforeAll(() => {
  sql = postgres(inject("postgresUrl"), { max: 8 });
  store = new PostgresProviderAccountStore(drizzle(sql));
});
afterAll(async () => {
  await sql.end();
});
async function fixture() {
  const db = drizzle(sql);
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Native fixture", isAnonymous: false })
    .returning();
  if (!user) throw new Error("No user");
  const [session] = await db
    .insert(authSessions)
    .values({ userId: user.id, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) })
    .returning();
  if (!session) throw new Error("No session");
  const account = await store.create({
    userId: user.id,
    driver: "claude",
    label: "Unverified label",
  });
  const owner = { userId: user.id, authSessionId: session.id };
  const secrets = new ProviderSecretBox(encryptionKeyFrom(Buffer.alloc(32, 11).toString("base64")));
  const driver: TerminalAuthDriver = {
    begin: async (context) => {
      await context.checkpoint(() => "private-process-reference");
    },
    poll: async () => {},
    status: () => ({
      kind: "waiting",
      interaction: { type: "terminal", output: "Open the provider's sign-in URL", input: "code" },
    }),
    verify: vi.fn<TerminalAuthDriver["verify"]>(async (context) => {
      expect(context.code).toBe("fixture-code");
      return {
        ok: true,
        value: {
          credentials: "private-native-home-grant",
          identity: { email: "verified@example.com", plan: null },
          proofs: [{ kind: "exit", sequence: 1, code: 0, reason: "exited", containment: "cgroup" }],
        },
      };
    }),
    cancel: vi.fn(async () => {}),
  };
  const build = () =>
    new TerminalProviderSignIn({
      accounts: store,
      attempts: store,
      processes: store,
      secrets,
      drivers: new Map([["claude", driver]]),
    });
  return { build, driver, secrets, account, owner };
}
it("resumes private native login on another API instance, consumes its code once, and promotes only verified identity", async () => {
  const f = await fixture();
  const started = await f.build().start(f.owner, f.account);
  if (!started.ok) throw new Error("No sign-in");
  expect(JSON.stringify(started)).not.toContain("private-process-reference");
  const result = await f
    .build()
    .submitCode(f.owner, f.account, { flowId: started.value.flowId, code: "fixture-code" });
  expect(result).toMatchObject({ ok: true, value: { phase: "succeeded" } });
  expect(await store.get(f.owner.userId, f.account.id)).toMatchObject({
    auth: { status: "authenticated", email: "verified@example.com", plan: null },
  });
  expect(
    await f
      .build()
      .submitCode(f.owner, f.account, { flowId: started.value.flowId, code: "fixture-code" }),
  ).toMatchObject({ ok: false });
  expect(f.driver.verify).toHaveBeenCalledTimes(1);
  const authorization = await store.authorization(f.owner.userId, f.account.id);
  if (authorization?.kind !== "connected") throw new Error("No verified authorization");
  expect(
    f.secrets.open(
      {
        kind: "authorization",
        userId: f.owner.userId,
        accountId: f.account.id,
        driver: "claude",
        generation: authorization.generation,
      },
      authorization.credentials,
    ),
  ).toEqual({ ok: true, value: "private-native-home-grant" });
});
it("refuses to promote a native login backed only by process-group termination", async () => {
  const f = await fixture();
  f.driver.verify = async () => ({
    ok: true,
    value: {
      credentials: "must-not-be-promoted",
      identity: { email: "wrong@example.com", plan: null },
      proofs: [
        { kind: "exit", sequence: 1, code: 0, reason: "exited", containment: "process_group" },
      ],
    },
  });
  const runner = f.build();
  const started = await runner.start(f.owner, f.account);
  if (!started.ok) throw new Error("No sign-in");
  expect(
    await runner.submitCode(f.owner, f.account, {
      flowId: started.value.flowId,
      code: "fixture-code",
    }),
  ).toMatchObject({ ok: true, value: { phase: "failed" } });
  expect(await store.authorization(f.owner.userId, f.account.id)).toMatchObject({
    kind: "disconnected",
  });
});

it("rejects concurrent replay and a late verified result after logout", async () => {
  const f = await fixture();
  let entered = () => {};
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const verify = vi.fn<TerminalAuthDriver["verify"]>(async () => {
    entered();
    await gate;
    return {
      ok: true,
      value: {
        credentials: "late-private-grant",
        identity: { email: "late@example.com", plan: null },
        proofs: [{ kind: "exit", sequence: 1, code: 0, reason: "exited", containment: "cgroup" }],
      },
    };
  });
  f.driver.verify = verify;
  const first = f.build();
  const second = f.build();
  const started = await first.start(f.owner, f.account);
  if (!started.ok) throw new Error("No sign-in");
  const input = { flowId: started.value.flowId, code: "fixture-code" };
  const verifying = first.submitCode(f.owner, f.account, input);
  await waiting;
  expect(await second.submitCode(f.owner, f.account, input)).toMatchObject({
    ok: false,
    error: { code: "stale" },
  });
  await store.revokeAuthorization(f.owner.userId, f.account.id);
  release();
  expect(await verifying).toMatchObject({ ok: false });
  expect(verify).toHaveBeenCalledTimes(1);
  expect(await store.authorization(f.owner.userId, f.account.id)).toMatchObject({
    kind: "disconnected",
  });
});
