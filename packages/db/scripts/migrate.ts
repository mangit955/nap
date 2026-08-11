/**
 * Applies the committed migrations to a real database.
 *
 * `bun run db:migrate`
 *
 * The test suites have never needed this: every one of them starts a throwaway container and
 * migrates it in `startMigratedPostgres`. A *development* database had no such path at all —
 * it was migrated by hand once and then quietly drifted, which nobody noticed until a task
 * added a second migration and `bun run dev` started answering with tables that do not exist.
 *
 * Deliberately not run at boot. Migrations against a shared database are a deploy step with
 * its own failure modes, and an API process that silently alters schema on startup is one that
 * does so once per replica, concurrently.
 */

import { join } from "node:path";
import { loadEnvFile } from "@nap/shared/env-file";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Credentials live here by convention; Bun only auto-loads a `.env` from the working directory. */
const ENV_FILE = join(import.meta.dirname, "..", "..", "..", "apps", "api", ".env");
const MIGRATIONS_FOLDER = join(import.meta.dirname, "..", "drizzle");

loadEnvFile(ENV_FILE, process.env);

const url = process.env.DATABASE_URL;
if (url === undefined || url === "") {
  console.error(`DATABASE_URL is not set. Add it to ${ENV_FILE}, or export it, then retry.`);
  process.exit(1);
}

// One connection: this runs a handful of statements once and then exits. Notices are
// swallowed because drizzle's bookkeeping is all `create … if not exists`, so every ordinary
// re-run printed two NOTICE objects that read exactly like errors — output that cries wolf on
// the success path is how people learn to stop reading it.
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
  console.log("Migrations applied.");
} catch (error) {
  console.error(`Could not apply migrations: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
} finally {
  await sql.end();
}
