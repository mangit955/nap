/**
 * A throwaway Postgres with this repo's migrations already applied.
 *
 * The `db` suite starts one of these once for the whole project, through its `globalSetup`.
 * A test that needs a real database *outside* that project — the full-cycle integration test
 * composes the Postgres stores against real E2B and real R2 — cannot reach that container, and
 * giving the integration project a `globalSetup` of its own would make every run of it start a
 * database that most of its files have no use for. So the container is a function anything can
 * call, and the `globalSetup` becomes one of its two callers.
 *
 * A container rather than a developer's local database, in both cases: the rows are gone when
 * the process is, so nothing has to clean up after itself and no test can be poisoned by what
 * the last one left behind.
 */

import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Pinned rather than `latest`: `gen_random_uuid()` and the SQL the migrations emit are version-sensitive. */
export const POSTGRES_IMAGE = "postgres:17-alpine";

/** `packages/db/drizzle`, resolved from this file rather than from the process cwd. */
export const MIGRATIONS_FOLDER = join(import.meta.dirname, "..", "..", "drizzle");

export type MigratedPostgres = {
  url: string;
  stop: () => Promise<void>;
};

export async function startMigratedPostgres(): Promise<MigratedPostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    POSTGRES_IMAGE,
  ).start();
  const url = container.getConnectionUri();

  // Migrations run here, so every caller sees an already-migrated database. This is also the
  // first assertion either caller makes: if the migrations do not apply to a clean database,
  // nothing that needs one can start at all.
  const client = postgres(url, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.end();
  }

  return {
    url,
    stop: async () => {
      await container.stop();
    },
  };
}
