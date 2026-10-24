import { randomUUID } from "node:crypto";
import {
  ProviderSignInChallengeSchema,
  ProviderSignInClaimTokenSchema,
} from "@nap/shared/ports/provider-sign-in-store";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PostgresProviderAccountStore } from "./postgres-provider-account-store.ts";
import { authSessions, users } from "./schema.ts";

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
const HASH = ProviderSignInChallengeSchema.parse("a".repeat(64));
const WRONG_TOKEN = ProviderSignInClaimTokenSchema.parse("c".repeat(64));
const OTHER_HASH = ProviderSignInChallengeSchema.parse("b".repeat(64));
const STATE = { ciphertext: "sealed-provider-state", iv: "state-iv" };
const VERIFIED = {
  kind: "verified",
  credentials: { ciphertext: "sealed-grant", iv: "grant-iv" },
  identity: { email: "verified@example.com", plan: null },
} as const;
const INTERACTION = {
  type: "browser",
  url: "https://provider.example/authorize?state=one-time",
} as const;
async function owner(options: { anonymous?: boolean; expired?: boolean } = {}) {
  const [user] = await db
    .insert(users)
    .values({
      email: `${randomUUID()}@example.com`,
      name: "Ada",
      isAnonymous: options.anonymous ?? false,
    })
    .returning();
  if (!user) throw new Error("No fixture user");
  const [session] = await db
    .insert(authSessions)
    .values({
      userId: user.id,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + (options.expired ? -60_000 : 3_600_000)),
    })
    .returning();
  if (!session) throw new Error("No fixture session");
  const account = await store.create({ userId: user.id, driver: "claude", label: null });
  return { userId: user.id, authSessionId: session.id, accountId: account.id };
}
async function started(who: Awaited<ReturnType<typeof owner>>) {
  const result = await store.beginSignIn({ owner: who, challengeHash: HASH, state: STATE });
  if (result.kind !== "updated") throw new Error("No fixture attempt");
  return result.attempt;
}
async function waiting(who: Awaited<ReturnType<typeof owner>>) {
  const attempt = await started(who);
  await store.presentSignIn({
    owner: who,
    flowId: attempt.flowId,
    state: STATE,
    interaction: INTERACTION,
  });
  return attempt;
}

describe("durable provider sign-in attempts", () => {
  it("survives a store restart, consumes callback claims once, and commits credentials with success", async () => {
    const who = await owner();
    const attempt = await waiting(who);
    const restarted = new PostgresProviderAccountStore(db);
    const view = await restarted.currentSignIn(who);
    expect(view).toMatchObject({
      flowId: attempt.flowId,
      phase: "waiting",
      interaction: INTERACTION,
    });
    expect(JSON.stringify(view)).not.toContain(STATE.ciphertext);
    const claim = await restarted.claimSignIn({
      owner: who,
      flowId: attempt.flowId,
      challengeHash: HASH,
    });
    if (claim.kind !== "claimed") throw new Error("Callback not claimed");
    expect(claim).toMatchObject({
      kind: "claimed",
      generation: 0,
      accountId: who.accountId,
      state: STATE,
    });
    await expect(
      store.claimSignIn({ owner: who, flowId: attempt.flowId, challengeHash: HASH }),
    ).resolves.toEqual({ kind: "stale" });
    await expect(store.currentSignIn(who)).resolves.toMatchObject({
      phase: "verifying",
      interaction: null,
    });
    await expect(
      store.finishSignIn({
        owner: who,
        flowId: attempt.flowId,
        outcome: { ...VERIFIED, claimToken: WRONG_TOKEN },
      }),
    ).resolves.toEqual({ kind: "stale" });
    await expect(
      store.finishSignIn({
        owner: who,
        flowId: attempt.flowId,
        outcome: { ...VERIFIED, claimToken: claim.claimToken },
      }),
    ).resolves.toMatchObject({
      kind: "updated",
      attempt: { phase: "succeeded", interaction: null },
    });
    await expect(store.authorization(who.userId, who.accountId)).resolves.toMatchObject({
      kind: "connected",
      generation: 1,
      credentials: VERIFIED.credentials,
    });
    await expect(store.get(who.userId, who.accountId)).resolves.toMatchObject({
      auth: { status: "authenticated", email: VERIFIED.identity.email },
    });
    await expect(
      store.finishSignIn({
        owner: who,
        flowId: attempt.flowId,
        outcome: { ...VERIFIED, claimToken: claim.claimToken },
      }),
    ).resolves.toEqual({ kind: "stale" });
    expect(
      await sql`select state_ciphertext, state_iv, challenge_hash from provider_sign_in_attempts where id = ${attempt.flowId}`,
    ).toEqual([{ state_ciphertext: null, state_iv: null, challenge_hash: null }]);
  });

  it("hides another owner or Nap session and refuses anonymous or expired sessions", async () => {
    const who = await owner();
    const stranger = await owner();
    const attempt = await waiting(who);
    const [otherSession] = await db
      .insert(authSessions)
      .values({
        userId: who.userId,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning();
    if (!otherSession) throw new Error("No other session");
    for (const actor of [
      { ...stranger, accountId: who.accountId },
      { ...who, authSessionId: otherSession.id },
      { ...who, authSessionId: stranger.authSessionId },
    ]) {
      await expect(store.currentSignIn(actor)).resolves.toBeNull();
      await expect(
        store.claimSignIn({ owner: actor, flowId: attempt.flowId, challengeHash: HASH }),
      ).resolves.toEqual({ kind: "missing" });
    }
    for (const actor of [await owner({ anonymous: true }), await owner({ expired: true })]) {
      await expect(
        store.beginSignIn({ owner: actor, challengeHash: HASH, state: STATE }),
      ).resolves.toEqual({ kind: "missing" });
    }
    await expect(
      store.claimSignIn({ owner: who, flowId: attempt.flowId, challengeHash: OTHER_HASH }),
    ).resolves.toEqual({ kind: "stale" });
    await expect(
      store.claimSignIn({ owner: who, flowId: attempt.flowId, challengeHash: HASH }),
    ).resolves.toMatchObject({ kind: "claimed" });
  });

  it("admits only one concurrent callback across workers", async () => {
    const who = await owner();
    const attempt = await waiting(who);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        new PostgresProviderAccountStore(db).claimSignIn({
          owner: who,
          flowId: attempt.flowId,
          challengeHash: HASH,
        }),
      ),
    );
    expect(results.filter((result) => result.kind === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "stale")).toHaveLength(3);
  });

  it("fences completions after logout, disable, cancellation and replacement", async () => {
    for (const action of ["logout", "disable", "cancel", "replace"] as const) {
      const who = await owner();
      const attempt = await waiting(who);
      const claim = await store.claimSignIn({
        owner: who,
        flowId: attempt.flowId,
        challengeHash: HASH,
      });
      if (claim.kind !== "claimed") throw new Error("Callback not claimed");
      if (action === "logout") await store.revokeAuthorization(who.userId, who.accountId);
      if (action === "disable") await store.update(who.userId, who.accountId, { enabled: false });
      if (action === "cancel") await store.cancelSignIn({ owner: who, flowId: attempt.flowId });
      if (action === "replace") await started(who);
      const outcome = await store.finishSignIn({
        owner: who,
        flowId: attempt.flowId,
        outcome: { ...VERIFIED, claimToken: claim.claimToken },
      });
      expect(outcome.kind).toBe(action === "disable" ? "disabled" : "stale");
      await expect(store.authorization(who.userId, who.accountId)).resolves.toMatchObject({
        kind: "disconnected",
      });
      expect(
        await sql`select state_ciphertext from provider_sign_in_attempts where id = ${attempt.flowId}`,
      ).toEqual([{ state_ciphertext: null }]);
    }
  });

  it("expires waiting and claimed attempts without persisting a late grant", async () => {
    for (const claimed of [false, true]) {
      const who = await owner();
      const attempt = await waiting(who);
      const claim = claimed
        ? await store.claimSignIn({ owner: who, flowId: attempt.flowId, challengeHash: HASH })
        : null;
      await sql`update provider_sign_in_attempts set created_at = clock_timestamp() - interval '6 minutes', expires_at = clock_timestamp() - interval '1 second' where id = ${attempt.flowId}`;
      const result =
        claim?.kind === "claimed"
          ? await store.finishSignIn({
              owner: who,
              flowId: attempt.flowId,
              outcome: { ...VERIFIED, claimToken: claim.claimToken },
            })
          : await store.claimSignIn({ owner: who, flowId: attempt.flowId, challengeHash: HASH });
      expect(result).toEqual({ kind: "expired" });
      await expect(store.currentSignIn(who)).resolves.toMatchObject({
        phase: "failed",
        message: "Sign-in expired. Start again.",
        interaction: null,
      });
      await expect(store.authorization(who.userId, who.accountId)).resolves.toMatchObject({
        kind: "disconnected",
      });
      expect(
        await sql`select state_ciphertext from provider_sign_in_attempts where id = ${attempt.flowId}`,
      ).toEqual([{ state_ciphertext: null }]);
    }
  });

  it("deletes private attempt state when its Nap session or provider account is deleted", async () => {
    for (const remove of ["session", "account"]) {
      const who = await owner();
      const attempt = await waiting(who);
      if (remove === "session")
        await sql`delete from auth_sessions where id = ${who.authSessionId}`;
      else await store.remove(who.userId, who.accountId);
      await expect(
        store.finishSignIn({
          owner: who,
          flowId: attempt.flowId,
          outcome: { ...VERIFIED, claimToken: WRONG_TOKEN },
        }),
      ).resolves.toEqual({ kind: "missing" });
      expect(
        await sql`select id from provider_sign_in_attempts where id = ${attempt.flowId}`,
      ).toHaveLength(0);
    }
  });
});

it("commits only one verified completion across workers", async () => {
  const who = await owner();
  const attempt = await waiting(who);
  const claim = await store.claimSignIn({
    owner: who,
    flowId: attempt.flowId,
    challengeHash: HASH,
  });
  if (claim.kind !== "claimed") throw new Error("Callback not claimed");
  const rows =
    await sql`select claim_token_hash from provider_sign_in_attempts where id = ${attempt.flowId}`;
  expect(rows[0]?.claim_token_hash).not.toBe(claim.claimToken);
  expect(JSON.stringify(await store.currentSignIn(who))).not.toContain(claim.claimToken);
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      new PostgresProviderAccountStore(db).finishSignIn({
        owner: who,
        flowId: attempt.flowId,
        outcome: { ...VERIFIED, claimToken: claim.claimToken },
      }),
    ),
  );
  expect(results.filter((result) => result.kind === "updated")).toHaveLength(1);
  expect(results.filter((result) => result.kind === "stale")).toHaveLength(3);
  await expect(store.authorization(who.userId, who.accountId)).resolves.toMatchObject({
    generation: 1,
    version: 1,
  });
});

it("refuses completion when the bound Nap session expires after the claim", async () => {
  const who = await owner();
  const attempt = await waiting(who);
  const claim = await store.claimSignIn({
    owner: who,
    flowId: attempt.flowId,
    challengeHash: HASH,
  });
  if (claim.kind !== "claimed") throw new Error("Callback not claimed");
  await sql`update auth_sessions set expires_at = clock_timestamp() - interval '1 second' where id = ${who.authSessionId}`;
  await expect(
    store.finishSignIn({
      owner: who,
      flowId: attempt.flowId,
      outcome: { ...VERIFIED, claimToken: claim.claimToken },
    }),
  ).resolves.toEqual({ kind: "missing" });
  await expect(store.authorization(who.userId, who.accountId)).resolves.toMatchObject({
    kind: "disconnected",
  });
});

it("records fixed provider failures, erases private state, and refuses disabled accounts", async () => {
  const who = await owner();
  const attempt = await started(who);
  await expect(
    store.finishSignIn({
      owner: who,
      flowId: attempt.flowId,
      outcome: { kind: "failed", reason: "provider_unavailable" },
    }),
  ).resolves.toMatchObject({
    kind: "updated",
    attempt: {
      phase: "failed",
      interaction: null,
      message: "The provider could not be reached. Start again.",
    },
  });
  expect(
    await sql`select state_ciphertext, state_iv, challenge_hash from provider_sign_in_attempts where id = ${attempt.flowId}`,
  ).toEqual([{ state_ciphertext: null, state_iv: null, challenge_hash: null }]);
  await store.update(who.userId, who.accountId, { enabled: false });
  await expect(
    store.beginSignIn({ owner: who, challengeHash: HASH, state: STATE }),
  ).resolves.toEqual({ kind: "disabled" });
});

it("enforces one active attempt and consistent sealed state at the database boundary", async () => {
  const who = await owner();
  const attempt = await waiting(who);
  await expect(
    sql`insert into provider_sign_in_attempts (account_id, auth_session_id, generation, phase, challenge_hash, state_ciphertext, state_iv, expires_at) values (${who.accountId}, ${who.authSessionId}, 0, 'starting', ${HASH}, 'sealed', 'iv', clock_timestamp() + interval '5 minutes')`,
  ).rejects.toMatchObject({ code: "23505" });
  await expect(
    sql`update provider_sign_in_attempts set state_iv = null where id = ${attempt.flowId}`,
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    sql`update provider_sign_in_attempts set phase = 'verifying', interaction = null where id = ${attempt.flowId}`,
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    sql`update provider_sign_in_attempts set phase = 'succeeded', interaction = null where id = ${attempt.flowId}`,
  ).rejects.toMatchObject({ code: "23514" });
  await expect(store.currentSignIn(who)).resolves.toMatchObject({ phase: "waiting" });
});

it("serializes concurrent starts without leaving multiple active secrets", async () => {
  const who = await owner();
  const attempts = await Promise.all(
    Array.from({ length: 4 }, () =>
      new PostgresProviderAccountStore(db).beginSignIn({
        owner: who,
        challengeHash: HASH,
        state: STATE,
      }),
    ),
  );
  expect(attempts.every((result) => result.kind === "updated")).toBe(true);
  const rows =
    await sql`select phase, state_ciphertext, challenge_hash from provider_sign_in_attempts where account_id = ${who.accountId}`;
  expect(rows.filter((row) => row.phase === "starting")).toHaveLength(1);
  expect(rows.filter((row) => row.phase === "cancelled")).toHaveLength(3);
  for (const row of rows.filter((row) => row.phase === "cancelled"))
    expect(row).toMatchObject({ state_ciphertext: null, challenge_hash: null });
});

it("orders callback locks with Nap account deletion without deadlocking", async () => {
  const who = await owner();
  const attempt = await waiting(who);
  const claim = await store.claimSignIn({
    owner: who,
    flowId: attempt.flowId,
    challengeHash: HASH,
  });
  if (claim.kind !== "claimed") throw new Error("Callback not claimed");
  let locked: () => void = () => {};
  let remove: () => void = () => {};
  const locks = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    remove = resolve;
  });
  let backendPid = 0;
  const deletion = sql.begin(async (tx) => {
    const [row] = await tx`select pg_backend_pid() as pid`;
    backendPid = Number(row?.pid);
    await tx`select id from users where id = ${who.userId} for update`;
    await tx`select id from auth_sessions where id = ${who.authSessionId} for update`;
    locked();
    await proceed;
    await tx`delete from users where id = ${who.userId}`;
  });
  await locks;
  const completion = store.finishSignIn({
    owner: who,
    flowId: attempt.flowId,
    outcome: { ...VERIFIED, claimToken: claim.claimToken },
  });
  const settled = Promise.allSettled([completion, deletion]);
  try {
    await expect
      .poll(
        async () => {
          const [row] =
            await sql`select count(*)::int as count from pg_stat_activity where ${backendPid} = any(pg_blocking_pids(pid))`;
          return row?.count;
        },
        { timeout: 3000 },
      )
      .toBe(1);
    remove();
    const results = await settled;
    expect(results[0]).toEqual({ status: "fulfilled", value: { kind: "missing" } });
    expect(results[1]?.status).toBe("fulfilled");
    expect(await sql`select id from users where id = ${who.userId}`).toHaveLength(0);
  } finally {
    remove();
    await settled;
  }
});
