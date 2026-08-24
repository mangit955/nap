/**
 * The same throwaway migrated Postgres as `postgres-container.ts`, started with `docker` itself.
 *
 * **Testcontainers hangs under Bun.** `startMigratedPostgres` is what every Vitest suite uses
 * and it is the right thing there — Vitest runs on Node, where the library works. The load
 * harness cannot: it needs `Bun.serve` for the WebSocket upgrade, so it runs on Bun, and
 * `new PostgreSqlContainer().start()` never resolves there. The container appears, reports
 * healthy, and the process waits forever.
 *
 * So this asks Docker for a container directly and waits for it to answer SQL — which is all
 * the library was being used for. Two files rather than one because the difference is a runtime
 * incompatibility rather than a preference, and collapsing them would mean either every test
 * suite shelling out to `docker` or the harness importing something that does not work.
 *
 * Everything that decides whether the database is *the right one* — the image tag and the
 * migrations folder — is shared with the Vitest path, so the two cannot drift into being
 * different databases.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { MIGRATIONS_FOLDER, type MigratedPostgres, POSTGRES_IMAGE } from "./postgres-container.ts";

const run = promisify(execFile);

/** Generous: it covers pulling the image on a machine that has never seen it. */
const READY_TIMEOUT_MS = 120_000;

const PASSWORD = "nap-loadgen";

/** `0.0.0.0:55003` or `[::]:55003` on one of possibly several lines — the port is what matters. */
export function portFrom(dockerPortOutput: string): number {
  const match = dockerPortOutput.match(/:(\d+)\s*$/m);
  if (match?.[1] === undefined) {
    throw new Error(`could not read a published port from: ${dockerPortOutput}`);
  }
  return Number(match[1]);
}

/**
 * Starts Postgres, waits until it answers, applies the migrations, and hands back the URL.
 *
 * `--rm` and a `stop` that force-removes: a container outliving the process that started it is
 * a database somebody will later connect to by accident, and it is billed in memory either way.
 */
export async function startDockerPostgres(): Promise<MigratedPostgres> {
  const started = await run("docker", [
    "run",
    "--detach",
    "--rm",
    "--publish-all",
    "--env",
    `POSTGRES_PASSWORD=${PASSWORD}`,
    POSTGRES_IMAGE,
  ]);
  const containerId = started.stdout.trim();

  const stop = async () => {
    await run("docker", ["rm", "--force", containerId]).catch(() => undefined);
  };

  try {
    const published = await run("docker", ["port", containerId, "5432/tcp"]);
    const url = `postgres://postgres:${PASSWORD}@127.0.0.1:${portFrom(published.stdout)}/postgres`;

    // Published is not the same as accepting connections: Postgres starts, restarts itself once
    // during first-time initialisation, and only then listens. Polling a real query is the only
    // signal that survives that.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const client = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await client`select 1`;
        // Migrations run here, so every caller sees an already-migrated database — and if they
        // do not apply to a clean database, nothing that needs one can start at all.
        await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
        return { url, stop };
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      } finally {
        await client.end();
      }
    }
  } catch (error) {
    await stop();
    throw error;
  }
}
