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
} from "@nap/shared/ports/provider-account-store";
import type {
  ProviderAccount,
  UpdateProviderAccount,
} from "@nap/shared/provider-accounts-protocol";
import { and, asc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { providerAccounts } from "./schema.ts";

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
    if (!isUuid(id)) return null;
    const [row] = await this.#db
      .update(providerAccounts)
      .set({
        ...(update.label === undefined ? {} : { label: update.label }),
        ...(update.enabled === undefined ? {} : { enabled: update.enabled }),
        updatedAt: sql`now()`,
      })
      .where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.id, id)))
      .returning();
    return row === undefined ? null : toAccount(row);
  }

  async remove(userId: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const removed = await this.#db
      .delete(providerAccounts)
      .where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.id, id)))
      .returning({ id: providerAccounts.id });
    return removed.length > 0;
  }
}
