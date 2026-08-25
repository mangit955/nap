/**
 * The `user_api_keys` table, behind the `UserKeyStore` port.
 *
 * One row per person, so saving a key is an upsert on the primary key rather than a delete
 * followed by an insert — the second form has a window where somebody who replaced their key
 * has none, and a turn starting in that window would silently fall back to the free tier.
 *
 * `updatedAt` is mapped to an ISO string on the way out for the same reason snapshots are:
 * the column is `timestamptz`, the driver hands back a `Date`, and every contract above this
 * layer speaks strings.
 */

import type { NewStoredKey, StoredKeyRecord, UserKeyStore } from "@nap/shared/ports/user-key-store";
import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { userApiKeys } from "./schema.ts";

type KeyRow = typeof userApiKeys.$inferSelect;

function toRecord(row: KeyRow): StoredKeyRecord {
  return {
    userId: row.userId,
    platform: row.platform,
    ciphertext: row.ciphertext,
    iv: row.iv,
    hint: row.hint,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PostgresUserKeyStore implements UserKeyStore {
  readonly #db: PostgresJsDatabase;

  constructor(db: PostgresJsDatabase) {
    this.#db = db;
  }

  async get(userId: string): Promise<StoredKeyRecord | null> {
    const [row] = await this.#db.select().from(userApiKeys).where(eq(userApiKeys.userId, userId));
    return row === undefined ? null : toRecord(row);
  }

  async put(key: NewStoredKey): Promise<StoredKeyRecord> {
    const [row] = await this.#db
      .insert(userApiKeys)
      .values(key)
      .onConflictDoUpdate({
        target: userApiKeys.userId,
        set: {
          platform: key.platform,
          ciphertext: key.ciphertext,
          iv: key.iv,
          hint: key.hint,
          // Set by hand: `defaultNow()` only applies to the insert, so without this a replaced
          // key would still report the date the first one was saved. It is the *database's*
          // clock rather than `new Date()`, because the insert's default is, and two clocks
          // means a key replaced a second later can report an earlier `updatedAt` than the one
          // it replaced — which is what "when did I last change this?" must never say. The gap
          // is milliseconds of skew between a host and a container, so it goes unnoticed until
          // it does not.
          updatedAt: sql`now()`,
        },
      })
      .returning();

    // Postgres cannot return zero rows from a single-row upsert; a missing row here would mean
    // the driver contract changed underneath us.
    if (row === undefined) throw new Error("upsert into user_api_keys returned no row");
    return toRecord(row);
  }

  async remove(userId: string): Promise<void> {
    await this.#db.delete(userApiKeys).where(eq(userApiKeys.userId, userId));
  }
}
