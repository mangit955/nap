/**
 * Opening the connection pool.
 *
 * Separate from the stores on purpose: `PostgresEventStore` takes a database it did not
 * create, so a test can hand it the same connection it seeded its rows with, and one process
 * has one pool rather than one per component. Boot is the only place that owns a pool, and
 * `close` exists so a script can exit instead of hanging on an idle connection.
 */

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
  const sql = postgres(url, { max: options.max ?? 10 });
  return { db: drizzle(sql), close: () => sql.end() };
}
