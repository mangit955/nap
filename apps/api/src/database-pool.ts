/**
 * How many database connections each of Nap's processes opens.
 *
 * One rule, read by boot to size the pool and by `test/connection-budget.test.ts` to check that a
 * deployment's processes fit their database together. Two copies would agree until somebody
 * changed one.
 *
 * **The worker's pool follows its concurrency.** A worker runs `NAP_WORKER_CONCURRENCY` turns, and
 * each turn's event appends, lease renewals and transactions go through this pool alongside the
 * claim loop, the thumbnail lane and the wake-up announcements. postgres.js pipelines a statement
 * onto a busy connection rather than queueing it, so a small pool is slower rather than stuck,
 * with one exception: a connection inside a transaction takes nothing else. With a connection per
 * turn, every turn can be mid-transaction and the claim loop and the renewals still have one, and
 * a renewal that waits long enough loses its lease. So the default is the concurrency plus
 * `WORKER_POOL_HEADROOM`, and the environment refuses an explicit pool no larger than the
 * concurrency.
 *
 * **The others are flat.** The API's work is short statements per request, and its ten is what the
 * load baseline measured. The reaper sweeps one project at a time.
 *
 * **How long a caller waits for a connection is not measured**, because postgres.js 3.4 offers no
 * way to: no pool statistics, no hook when a query is queued or handed a connection. The `debug`
 * hook fires when a statement is written to a connection, but not when it was asked for.
 */

import type { NapRole } from "./compose.ts";
import type { Env } from "./env.ts";

/**
 * Connections a worker's pool keeps beyond one per turn: one for the claim loop, and one for
 * whatever else is not a turn — a renewal or an announcement arriving while every turn is in a
 * transaction. Kept small on purpose, because the free database has a hundred connections for
 * three processes and a rollout can hold every replica of each twice.
 */
export const WORKER_POOL_HEADROOM = 2;

export type PoolSettings = Pick<
  Env,
  | "NAP_API_DB_POOL_SIZE"
  | "NAP_WORKER_DB_POOL_SIZE"
  | "NAP_REAPER_DB_POOL_SIZE"
  | "NAP_WORKER_CONCURRENCY"
>;

/** The pool this process opens for its stores. */
export function databasePoolSize(role: NapRole, env: PoolSettings): number {
  const worker = env.NAP_WORKER_DB_POOL_SIZE ?? env.NAP_WORKER_CONCURRENCY + WORKER_POOL_HEADROOM;
  switch (role) {
    case "api":
      return env.NAP_API_DB_POOL_SIZE;
    case "worker":
      return worker;
    case "reaper":
      return env.NAP_REAPER_DB_POOL_SIZE;
    // One process doing all three jobs does all three jobs' querying.
    case "all":
      return env.NAP_API_DB_POOL_SIZE + worker + env.NAP_REAPER_DB_POOL_SIZE;
  }
}

/**
 * Every connection this process holds: its pool, the `LISTEN` socket that every process holds on
 * the Postgres bus, and the reaper's advisory-lock connection. The last two are outside the pool
 * by necessity; see `createListenerConnection` and `createLockConnection`.
 */
export function connectionsHeld(
  role: NapRole,
  env: PoolSettings & Pick<Env, "NAP_EVENT_BUS">,
): number {
  const listener = env.NAP_EVENT_BUS === "postgres" ? 1 : 0;
  const lock = role === "reaper" ? 1 : 0;
  return databasePoolSize(role, env) + listener + lock;
}
