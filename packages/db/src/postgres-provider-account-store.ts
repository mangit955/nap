import { createHash, randomBytes } from "node:crypto";
/**
 * The `provider_accounts` table, behind the `ProviderAccountStore` port.
 *
 * Every query is scoped by `user_id` as well as `id`, so a caller holding somebody else's account
 * id gets the same answer as one holding an id that never existed.
 *
 * An id that is not a uuid is answered as missing before it reaches the database. Postgres would
 * otherwise refuse the cast with an error, and a typo in a URL is a 404, not a 500.
 */

import type {
  NewProviderAccount,
  ProviderAccountStore,
  ProviderAuthorization,
  ProviderAuthorizationWrite,
  ProviderCredentialRefresh,
  ProviderSignInCommit,
} from "@nap/shared/ports/provider-account-store";
import {
  ProviderAuthorizationSchema,
  SealedProviderCredentialsSchema,
} from "@nap/shared/ports/provider-account-store";
import type {
  ProviderSignInAttempt,
  ProviderSignInAttemptWrite,
  ProviderSignInClaim,
  ProviderSignInOwner,
  ProviderSignInRefusal,
  ProviderSignInStore,
} from "@nap/shared/ports/provider-sign-in-store";
import {
  PROVIDER_SIGN_IN_TTL_MS,
  ProviderSignInAttemptSchema,
  ProviderSignInClaimTokenSchema,
} from "@nap/shared/ports/provider-sign-in-store";
import type {
  ProviderAccount,
  UpdateProviderAccount,
} from "@nap/shared/provider-accounts-protocol";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import {
  authSessions,
  providerAccounts,
  providerCredentials,
  providerSignInAttempts,
  users,
} from "./schema.ts";

type Transaction = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];
type CredentialRow = typeof providerCredentials.$inferSelect;

function toAuthorization(row: CredentialRow | undefined): ProviderAuthorization {
  const revision = { generation: row?.generation ?? 0, version: row?.version ?? 0 };
  return ProviderAuthorizationSchema.parse(
    row?.ciphertext == null
      ? { kind: "disconnected", ...revision }
      : { kind: "connected", ...revision, credentials: { ciphertext: row.ciphertext, iv: row.iv } },
  );
}

type SignInRow = typeof providerSignInAttempts.$inferSelect;
const ACTIVE_SIGN_INS = ["starting", "waiting", "verifying"] as const;
const isActiveSignIn = (row: SignInRow) => ACTIVE_SIGN_INS.some((phase) => phase === row.phase);
const signInHash = (value: string) => createHash("sha256").update(value).digest("hex");
const erasedSignIn = {
  stateCiphertext: null,
  stateIv: null,
  challengeHash: null,
  claimTokenHash: null,
  interaction: null,
  message: null,
};
function signInView(row: SignInRow): ProviderSignInAttempt {
  return ProviderSignInAttemptSchema.parse({
    flowId: row.id,
    phase: row.phase,
    interaction: row.interaction,
    message: row.message,
    expiresAt: row.expiresAt.toISOString(),
  });
}
type CheckedSignIn =
  | { kind: "usable"; row: SignInRow }
  | { kind: "expired" | "stale"; attempt: ProviderSignInAttempt };

type AccountRow = typeof providerAccounts.$inferSelect;

function toAccount(row: AccountRow): ProviderAccount {
  return {
    id: row.id,
    driver: row.driver,
    label: row.label,
    enabled: row.enabled,
    auth: { status: row.authStatus, email: row.accountEmail, plan: row.accountPlan },
    createdAt: row.createdAt.toISOString(),
  };
}

const isUuid = (id: string) => z.uuid().safeParse(id).success;

export class PostgresProviderAccountStore implements ProviderAccountStore, ProviderSignInStore {
  readonly #db: PostgresJsDatabase;

  constructor(db: PostgresJsDatabase) {
    this.#db = db;
  }

  async list(userId: string): Promise<ProviderAccount[]> {
    const rows = await this.#db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.userId, userId))
      // `id` breaks a tie between two accounts made in the same transaction, so the order is
      // the same on every read.
      .orderBy(asc(providerAccounts.createdAt), asc(providerAccounts.id));
    return rows.map(toAccount);
  }

  async get(userId: string, id: string): Promise<ProviderAccount | null> {
    if (!isUuid(id)) return null;
    const [row] = await this.#db
      .select()
      .from(providerAccounts)
      .where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.id, id)));
    return row === undefined ? null : toAccount(row);
  }

  async create(account: NewProviderAccount): Promise<ProviderAccount> {
    const [row] = await this.#db.insert(providerAccounts).values(account).returning();
    if (row === undefined) throw new Error("insert into provider_accounts returned no row");
    return toAccount(row);
  }

  async update(
    userId: string,
    id: string,
    update: UpdateProviderAccount,
  ): Promise<ProviderAccount | null> {
    return this.#owned(userId, id, async (tx, account) => {
      if (update.enabled === false && account.enabled) await this.#revoke(tx, id);
      const [row] = await tx
        .update(providerAccounts)
        .set({
          ...(update.label === undefined ? {} : { label: update.label }),
          ...(update.enabled === undefined ? {} : { enabled: update.enabled }),
          updatedAt: sql`now()`,
        })
        .where(eq(providerAccounts.id, id))
        .returning();
      if (row === undefined) throw new Error("locked provider account disappeared");
      return toAccount(row);
    });
  }

  async remove(userId: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const removed = await this.#db
      .delete(providerAccounts)
      .where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.id, id)))
      .returning({ id: providerAccounts.id });
    return removed.length > 0;
  }

  async authorization(userId: string, id: string): Promise<ProviderAuthorization | null> {
    if (!isUuid(id)) return null;
    const [row] = await this.#db
      .select({ credentials: providerCredentials })
      .from(providerAccounts)
      .leftJoin(providerCredentials, eq(providerCredentials.accountId, providerAccounts.id))
      .where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.id, id)));
    return row === undefined ? null : toAuthorization(row.credentials ?? undefined);
  }

  async completeSignIn(
    userId: string,
    id: string,
    commit: ProviderSignInCommit,
  ): Promise<ProviderAuthorizationWrite> {
    return (
      (await this.#owned<ProviderAuthorizationWrite>(userId, id, async (tx, account) => {
        if (!account.enabled) return { kind: "disabled" };
        const current = await this.#current(tx, id);
        if (current.generation !== commit.generation) return { kind: "stale" };
        const authorization = await this.#connect(tx, id, current, commit);
        await this.#invalidateSignIns(tx, id);
        return { kind: "updated", authorization };
      })) ?? { kind: "missing" }
    );
  }

  async replaceCredentials(
    userId: string,
    id: string,
    refresh: ProviderCredentialRefresh,
  ): Promise<ProviderAuthorizationWrite> {
    return (
      (await this.#owned<ProviderAuthorizationWrite>(userId, id, async (tx, account) => {
        if (!account.enabled) return { kind: "disabled" };
        const current = await this.#current(tx, id);
        if (
          current.kind !== "connected" ||
          current.generation !== refresh.generation ||
          current.version !== refresh.version
        )
          return { kind: "stale" };
        const authorization: ProviderAuthorization = {
          ...current,
          version: current.version + 1,
          credentials: refresh.credentials,
        };
        await this.#save(tx, id, authorization);
        return { kind: "updated", authorization };
      })) ?? { kind: "missing" }
    );
  }

  async revokeAuthorization(userId: string, id: string): Promise<ProviderAuthorization | null> {
    return this.#owned(userId, id, (tx) => this.#revoke(tx, id));
  }

  async beginSignIn(
    input: Parameters<ProviderSignInStore["beginSignIn"]>[0],
  ): Promise<ProviderSignInAttemptWrite> {
    return (
      (await this.#signInOwner<ProviderSignInAttemptWrite>(input.owner, async (tx, account) => {
        if (!account.enabled) return { kind: "disabled" };
        const state = SealedProviderCredentialsSchema.parse(input.state);
        const authorization = await this.#current(tx, account.id);
        await this.#invalidateSignIns(tx, account.id);
        const [row] = await tx
          .insert(providerSignInAttempts)
          .values({
            accountId: account.id,
            authSessionId: input.owner.authSessionId,
            generation: authorization.generation,
            phase: "starting",
            challengeHash: input.challengeHash,
            stateCiphertext: state.ciphertext,
            stateIv: state.iv,
            createdAt: sql`clock_timestamp()`,
            expiresAt: sql`clock_timestamp() + ${PROVIDER_SIGN_IN_TTL_MS} * interval '1 millisecond'`,
          })
          .returning();
        if (!row) throw new Error("provider sign-in insert returned no row");
        return { kind: "updated", attempt: signInView(row) };
      })) ?? { kind: "missing" }
    );
  }

  async presentSignIn(
    input: Parameters<ProviderSignInStore["presentSignIn"]>[0],
  ): Promise<ProviderSignInAttemptWrite> {
    return this.#signInAction(input, async (tx, row) => {
      if (row.phase !== "starting") return { kind: "stale" };
      const state = SealedProviderCredentialsSchema.parse(input.state);
      const [waiting] = await tx
        .update(providerSignInAttempts)
        .set({
          phase: "waiting",
          interaction: input.interaction,
          stateCiphertext: state.ciphertext,
          stateIv: state.iv,
        })
        .where(eq(providerSignInAttempts.id, row.id))
        .returning();
      if (!waiting) throw new Error("locked provider sign-in disappeared");
      return { kind: "updated", attempt: signInView(waiting) };
    });
  }

  async claimSignIn(
    input: Parameters<ProviderSignInStore["claimSignIn"]>[0],
  ): Promise<ProviderSignInClaim> {
    return this.#signInAction(input, async (tx, row) => {
      if (row.phase !== "waiting" || row.challengeHash !== input.challengeHash)
        return { kind: "stale" };
      const token = ProviderSignInClaimTokenSchema.parse(randomBytes(32).toString("hex"));
      const state = SealedProviderCredentialsSchema.parse({
        ciphertext: row.stateCiphertext,
        iv: row.stateIv,
      });
      await tx
        .update(providerSignInAttempts)
        .set({ phase: "verifying", interaction: null, claimTokenHash: signInHash(token) })
        .where(eq(providerSignInAttempts.id, row.id));
      return {
        kind: "claimed",
        flowId: row.id,
        accountId: row.accountId,
        generation: row.generation,
        claimToken: token,
        state,
      };
    });
  }

  async finishSignIn(
    input: Parameters<ProviderSignInStore["finishSignIn"]>[0],
  ): Promise<ProviderSignInAttemptWrite> {
    return this.#signInAction(input, async (tx, row) => {
      if (!isActiveSignIn(row)) return { kind: "stale" };
      if (input.outcome.kind === "failed") {
        const messages = {
          provider_unavailable: "The provider could not be reached. Start again.",
          verification_failed: "The provider could not verify this sign-in. Start again.",
        };
        return {
          kind: "updated",
          attempt: await this.#settleSignIn(tx, row.id, {
            phase: "failed",
            message: messages[input.outcome.reason],
          }),
        };
      }
      if (row.phase !== "verifying" || row.claimTokenHash !== signInHash(input.outcome.claimToken))
        return { kind: "stale" };
      const current = await this.#current(tx, row.accountId);
      await this.#connect(tx, row.accountId, current, {
        generation: row.generation,
        credentials: SealedProviderCredentialsSchema.parse(input.outcome.credentials),
        identity: input.outcome.identity,
      });
      return {
        kind: "updated",
        attempt: await this.#settleSignIn(tx, row.id, { phase: "succeeded", message: null }),
      };
    });
  }

  async cancelSignIn(
    input: Parameters<ProviderSignInStore["cancelSignIn"]>[0],
  ): Promise<ProviderSignInAttemptWrite> {
    return this.#signInAction(input, async (tx, row) => {
      if (row.phase === "cancelled") return { kind: "updated", attempt: signInView(row) };
      if (!isActiveSignIn(row)) return { kind: "stale" };
      return {
        kind: "updated",
        attempt: await this.#settleSignIn(tx, row.id, { phase: "cancelled", message: null }),
      };
    });
  }

  async currentSignIn(owner: ProviderSignInOwner): Promise<ProviderSignInAttempt | null> {
    return this.#signInOwner(owner, async (tx) => {
      const [found] = await tx
        .select({
          row: providerSignInAttempts,
          expired: sql<boolean>`${providerSignInAttempts.expiresAt} <= clock_timestamp()`,
        })
        .from(providerSignInAttempts)
        .where(
          and(
            eq(providerSignInAttempts.accountId, owner.accountId),
            eq(providerSignInAttempts.authSessionId, owner.authSessionId),
          ),
        )
        .orderBy(desc(providerSignInAttempts.createdAt), desc(providerSignInAttempts.id))
        .limit(1)
        .for("update");
      if (!found) return null;
      const checked = await this.#checkSignIn(tx, found.row, found.expired);
      return checked.kind === "usable" ? signInView(checked.row) : checked.attempt;
    });
  }

  async #signInAction<T>(
    input: { owner: ProviderSignInOwner; flowId: string },
    action: (tx: Transaction, row: SignInRow) => Promise<T>,
  ): Promise<T | ProviderSignInRefusal> {
    if (!isUuid(input.flowId)) return { kind: "missing" };
    return (
      (await this.#signInOwner<T | ProviderSignInRefusal>(input.owner, async (tx, account) => {
        if (!account.enabled) return { kind: "disabled" };
        const [found] = await tx
          .select({
            row: providerSignInAttempts,
            expired: sql<boolean>`${providerSignInAttempts.expiresAt} <= clock_timestamp()`,
          })
          .from(providerSignInAttempts)
          .where(
            and(
              eq(providerSignInAttempts.id, input.flowId),
              eq(providerSignInAttempts.accountId, account.id),
              eq(providerSignInAttempts.authSessionId, input.owner.authSessionId),
            ),
          )
          .for("update");
        if (!found) return { kind: "missing" };
        const checked = await this.#checkSignIn(tx, found.row, found.expired);
        if (checked.kind !== "usable") return { kind: checked.kind };
        return action(tx, checked.row);
      })) ?? { kind: "missing" }
    );
  }

  async #checkSignIn(tx: Transaction, row: SignInRow, expired: boolean): Promise<CheckedSignIn> {
    if (!isActiveSignIn(row)) return { kind: "usable", row };
    const authorization = await this.#current(tx, row.accountId);
    if (authorization.generation !== row.generation)
      return {
        kind: "stale",
        attempt: await this.#settleSignIn(tx, row.id, { phase: "cancelled", message: null }),
      };
    if (expired)
      return {
        kind: "expired",
        attempt: await this.#settleSignIn(tx, row.id, {
          phase: "failed",
          message: "Sign-in expired. Start again.",
        }),
      };
    return { kind: "usable", row };
  }

  async #settleSignIn(
    tx: Transaction,
    id: string,
    ending:
      | { phase: "failed"; message: string }
      | { phase: "cancelled" | "succeeded"; message: null },
  ): Promise<ProviderSignInAttempt> {
    const [row] = await tx
      .update(providerSignInAttempts)
      .set({ ...erasedSignIn, ...ending })
      .where(eq(providerSignInAttempts.id, id))
      .returning();
    if (!row) throw new Error("locked provider sign-in disappeared");
    return signInView(row);
  }

  async #invalidateSignIns(tx: Transaction, accountId: string): Promise<void> {
    await tx
      .update(providerSignInAttempts)
      .set({ ...erasedSignIn, phase: "cancelled" })
      .where(
        and(
          eq(providerSignInAttempts.accountId, accountId),
          inArray(providerSignInAttempts.phase, ACTIVE_SIGN_INS),
        ),
      );
  }

  async #signInOwner<T>(
    owner: ProviderSignInOwner,
    action: (tx: Transaction, account: AccountRow) => Promise<T>,
  ): Promise<T | null> {
    if (!isUuid(owner.userId) || !isUuid(owner.authSessionId) || !isUuid(owner.accountId))
      return null;
    return this.#db.transaction(async (tx) => {
      // Lock ancestors before descendants, matching user/session deletion cascades. Acquiring
      // the account first can deadlock a callback against deletion holding the Nap session.
      const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, owner.userId), eq(users.isAnonymous, false)))
        .for("share");
      if (user === undefined) return null;
      const [session] = await tx
        .select({ id: authSessions.id })
        .from(authSessions)
        .where(
          and(
            eq(authSessions.id, owner.authSessionId),
            eq(authSessions.userId, owner.userId),
            gt(authSessions.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .for("share");
      if (session === undefined) return null;
      const account = await this.#lockAccount(tx, owner.userId, owner.accountId);
      return account === undefined ? null : action(tx, account);
    });
  }

  async #connect(
    tx: Transaction,
    id: string,
    current: ProviderAuthorization,
    commit: ProviderSignInCommit,
  ): Promise<ProviderAuthorization> {
    const authorization: ProviderAuthorization = {
      kind: "connected",
      generation: current.generation + 1,
      version: current.version + 1,
      credentials: commit.credentials,
    };
    await this.#save(tx, id, authorization);
    await tx
      .update(providerAccounts)
      .set({
        authStatus: "authenticated",
        accountEmail: commit.identity.email,
        accountPlan: commit.identity.plan,
        updatedAt: sql`now()`,
      })
      .where(eq(providerAccounts.id, id));
    return authorization;
  }

  async #current(tx: Transaction, id: string): Promise<ProviderAuthorization> {
    const [row] = await tx
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.accountId, id));
    return toAuthorization(row);
  }

  async #save(tx: Transaction, id: string, authorization: ProviderAuthorization): Promise<void> {
    const value = {
      accountId: id,
      generation: authorization.generation,
      version: authorization.version,
      ciphertext: authorization.kind === "connected" ? authorization.credentials.ciphertext : null,
      iv: authorization.kind === "connected" ? authorization.credentials.iv : null,
    };
    await tx
      .insert(providerCredentials)
      .values(value)
      .onConflictDoUpdate({ target: providerCredentials.accountId, set: value });
  }

  async #revoke(tx: Transaction, id: string): Promise<ProviderAuthorization> {
    const current = await this.#current(tx, id);
    const authorization: ProviderAuthorization = {
      kind: "disconnected",
      generation: current.generation + 1,
      version: current.version + 1,
    };
    await this.#save(tx, id, authorization);
    await tx
      .update(providerAccounts)
      .set({
        authStatus: "unauthenticated",
        accountEmail: null,
        accountPlan: null,
        updatedAt: sql`now()`,
      })
      .where(eq(providerAccounts.id, id));
    await this.#invalidateSignIns(tx, id);
    return authorization;
  }

  // All authorization mutations lock the parent, including the first write with no credential row.
  // This serializes login, refresh and disable across workers without locking another owner's row.
  async #owned<T>(
    userId: string,
    id: string,
    change: (tx: Transaction, account: AccountRow) => Promise<T>,
  ): Promise<T | null> {
    if (!isUuid(id)) return null;
    return this.#db.transaction(async (tx) => {
      const account = await this.#lockAccount(tx, userId, id);
      return account === undefined ? null : change(tx, account);
    });
  }
  async #lockAccount(tx: Transaction, userId: string, id: string): Promise<AccountRow | undefined> {
    const [account] = await tx
      .select()
      .from(providerAccounts)
      .where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.id, id)))
      .for("update");
    return account;
  }
}
