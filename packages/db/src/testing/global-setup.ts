/**
 * One Postgres container for the whole `db` suite.
 *
 * Starting a container per test file would dominate the runtime, so the container and the
 * migrations are set up once here and every test file connects to the same database. Tests
 * must therefore not assume an empty table — they insert their own rows and assert on those.
 *
 * The connection string reaches the tests through Vitest's `provide`/`inject` rather than an
 * environment variable, so a test that forgets to set it up fails to compile rather than
 * silently talking to a developer's local database.
 */

import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    postgresUrl: string;
  }
}

/** Pinned rather than `latest`: `gen_random_uuid()` and the SQL the migrations emit are version-sensitive. */
const POSTGRES_IMAGE = "postgres:17-alpine";

/** `packages/db/drizzle`, resolved from this file rather than from the process cwd. */
export const MIGRATIONS_FOLDER = join(import.meta.dirname, "..", "..", "drizzle");

let container: StartedPostgreSqlContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();

  // Migrations run once, here, so every test file sees an already-migrated database.
  // This is also the task's first assertion: if the migrations do not apply to a clean
  // database, the suite cannot start at all.
  const client = postgres(url, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.end();
  }

  project.provide("postgresUrl", url);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
