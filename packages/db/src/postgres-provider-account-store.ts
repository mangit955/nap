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
import { ProviderAuthorizationSchema } from "@nap/shared/ports/provider-account-store";
import type {
  ProviderAccount,
  UpdateProviderAccount,
} from "@nap/shared/provider-accounts-protocol";
import { and, asc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { providerAccounts, providerCredentials } from "./schema.ts";

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

export class PostgresProviderAccountStore implements ProviderAccountStore {
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
      const [account] = await tx
        .select()
        .from(providerAccounts)
        .where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.id, id)))
        .for("update");
      return account === undefined ? null : change(tx, account);
    });
  }
}
