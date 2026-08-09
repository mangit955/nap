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
 *
 * Starting the container is `startMigratedPostgres`'s job rather than this file's: a suite in
 * another Vitest project needs the same database and has no way to reach a `globalSetup` bound
 * to this one.
 */

import type { TestProject } from "vitest/node";
import { type MigratedPostgres, startMigratedPostgres } from "./postgres-container.ts";

declare module "vitest" {
  interface ProvidedContext {
    postgresUrl: string;
  }
}

let database: MigratedPostgres | undefined;

export async function setup(project: TestProject): Promise<void> {
  database = await startMigratedPostgres();

  project.provide("postgresUrl", database.url);
}

export async function teardown(): Promise<void> {
  await database?.stop();
}
