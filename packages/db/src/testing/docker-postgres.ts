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

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { MIGRATIONS_FOLDER, type MigratedPostgres, POSTGRES_IMAGE } from "./postgres-container.ts";

/** Generous: it covers pulling the image on a machine that has never seen it. */
const READY_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const DRAIN_TIMEOUT_MS = 1_000;

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
export async function startDockerPostgres(
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<MigratedPostgres> {
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("Postgres startup timeoutMs must be positive and fit a timer");
  }
  options.signal?.throwIfAborted();
  const startup = new AbortController();
  const abort = () => startup.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => startup.abort(new Error(`Postgres startup timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const { signal } = startup;
  // The name is owned before Docker can allocate, even if its stdout never delivers the ID.
  const name = `nap-postgres-${randomUUID()}`;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= removeOwnedContainer(name).catch((error: unknown) => {
      stopping = undefined; // A failed cleanup can be retried by the owner.
      throw error;
    });
    return stopping;
  };

  try {
    await runDocker(
      [
        "run",
        "--detach",
        "--rm",
        "--name",
        name,
        "--publish-all",
        "--env",
        `POSTGRES_PASSWORD=${PASSWORD}`,
        POSTGRES_IMAGE,
      ],
      signal,
    );
    const published = await runDocker(["port", name, "5432/tcp"], signal);
    const url = `postgres://postgres:${PASSWORD}@127.0.0.1:${portFrom(published)}/postgres`;

    // Published is not the same as accepting connections: Postgres restarts itself during
    // first-time initialisation. Each attempt shares the acquisition deadline, including SQL.
    for (;;) {
      signal.throwIfAborted();
      const client = postgres(url, { max: 1, onnotice: () => {} });
      const work = (async () => {
        await client`select 1`;
        signal.throwIfAborted();
        await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
        signal.throwIfAborted();
      })();
      try {
        await untilAborted(work, signal);
      } catch {
        signal.throwIfAborted();
        await delay(250, undefined, { signal });
        continue;
      } finally {
        // end(timeout:0) terminates active postgres.js queries instead of waiting for SQL.
        await drain(client.end({ timeout: 0 }), "Postgres client shutdown");
        await drain(
          work.catch(() => {}),
          "Postgres SQL",
        );
      }
      signal.throwIfAborted();
      return { url, stop };
    }
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Postgres startup failed; cleanup failed for ${name}: ${String(cleanupError)}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

/** Kill and drain the allocating CLI before rollback; a raced promise can allocate after cleanup. */
function runDocker(args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let failure: unknown;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (error: unknown) => {
      failure ??= error;
      child.kill("SIGKILL");
      drainTimer ??= setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(new AggregateError([failure], `Docker process did not drain: ${args[0]}`));
      }, DRAIN_TIMEOUT_MS);
    };
    const aborted = () => kill(signal.reason);
    const finish = (error?: unknown) => {
      clearTimeout(drainTimer);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve(stdout);
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1_048_576) kill(new Error("Docker stdout exceeded 1MiB"));
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 1_048_576) kill(new Error("Docker stderr exceeded 1MiB"));
    });
    child.on("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code) =>
      finish(
        failure ??
          (code === 0 ? undefined : new Error(`docker ${args[0]} failed (${code}): ${stderr}`)),
      ),
    );
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

async function removeOwnedContainer(name: string): Promise<void> {
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  // Cleanup has its own budget. An aborted startup must still be able to remove its database.
  try {
    await runDocker(["rm", "--force", name], AbortSignal.timeout(CLEANUP_TIMEOUT_MS / 2));
  } catch {
    // `--rm` may already have removed it. Only an exact, successful inventory proves absence.
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`Postgres cleanup deadline exceeded for ${name}`);
  const found = await runDocker(
    ["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"],
    AbortSignal.timeout(remaining),
  );
  if (found.trim())
    throw new Error(`Postgres cleanup left owned container ${name}: ${found.trim()}`);
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function drain<T>(work: Promise<T>, description: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`${description} did not drain`)),
    DRAIN_TIMEOUT_MS,
  );
  try {
    return await untilAborted(work, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
