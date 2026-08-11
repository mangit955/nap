/**
 * Opening the connection pool.
 *
 * Separate from the stores on purpose: `PostgresEventStore` takes a database it did not
 * create, so a test can hand it the same connection it seeded its rows with, and one process
 * has one pool rather than one per component. Boot is the only place that owns a pool, and
 * `close` exists so a script can exit instead of hanging on an idle connection.
 */

import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type Database = {
  db: PostgresJsDatabase;
  close: () => Promise<void>;
};

export type CreateDatabaseOptions = {
  /** Pool size. The default suits one API process; a script wants far fewer. */
  max?: number;
};

export function createDatabase(url: string, options: CreateDatabaseOptions = {}): Database {
  const connection = postgres(url, { max: options.max ?? 10 });
  return { db: drizzle(connection), close: () => connection.end() };
}

/**
 * A round trip to the database, for a health check to wait on.
 *
 * `select 1` rather than a query against a real table: this asks whether the database is
 * reachable and answering, which is the thing a health check can act on. A query that also
 * depended on a particular table would report a migration problem as an outage, and those
 * two need different people.
 *
 * Rejects when the database does not answer. Whoever calls it decides what that means — see
 * `HealthCheck` in the API, which treats resolving as reachable and anything else as down.
 */
export async function pingDatabase(db: PostgresJsDatabase): Promise<void> {
  await db.execute(sql`select 1`);
}
