/**
 * One sweeper at a time, held as a Postgres session-level advisory lock.
 *
 * This is the deployment's whole leader election. There is no Kubernetes Lease, no etcd and no
 * coordination service: the reaper runs as one replica, and this is what makes a *rollout overlap*
 * — the new pod ticking while the old one is still draining — not a second sweeper.
 *
 * **Session-level, so it needs a connection of its own.** A session lock belongs to the backend
 * that took it, and the pool hands the next statement to whichever backend is free: taken through
 * the pool, the lock would be held by a connection this object may never see again and released by
 * one that never had it. `createLockConnection` is the `max: 1` socket this takes instead, for the
 * same reason `LISTEN` has one.
 *
 * **Asked every tick, and the backend pid is what makes that cheap and correct.**
 * `pg_try_advisory_lock` is re-entrant within a session — asking again while holding it succeeds
 * and increments a counter, so a reaper ticking every minute would be sixty deep after an hour and
 * one `pg_advisory_unlock` would release nothing. So the holder is remembered as the pid that took
 * it, and the statement only reaches `pg_try_advisory_lock` when this is not that backend. That
 * also handles the case a boolean could not: postgres.js reconnects silently, and a new backend
 * means the old session's locks are gone — the pid has changed, so the lock is taken again rather
 * than assumed.
 */

import type { SweepLock } from "@nap/shared/ports/sweep-lock";
import type { Sql } from "postgres";

/**
 * What the reaper's sweeps contend on.
 *
 * `hashtext` of a searchable string rather than a magic number, which is the idiom the capacity
 * ceiling and the rate limiter already use. Collisions map two unrelated names onto one lock, which
 * costs contention and never correctness — and there are three of these in the whole codebase.
 */
export const SWEEP_LOCK = "nap:reaper-sweep";

export class PostgresAdvisoryLock implements SweepLock {
  readonly #sql: Sql;
  readonly #name: string;
  /** The backend that took the lock, or null when this process does not hold it. */
  #heldBy: number | null = null;

  /** Takes a connection of its own — see the note above; a pooled one cannot hold this. */
  constructor(sql: Sql, name: string = SWEEP_LOCK) {
    this.#sql = sql;
    this.#name = name;
  }

  async held(): Promise<boolean> {
    const [row] = await this.#sql<{ pid: number; held: boolean }[]>`
      select
        pg_backend_pid() as pid,
        case
          when ${this.#heldBy}::int = pg_backend_pid() then true
          else pg_try_advisory_lock(hashtext(${this.#name}))
        end as held`;

    // A driver that answered nothing to a statement with no from-clause would mean the contract
    // changed under us; not sweeping is the safe reading either way.
    if (row === undefined || !row.held) {
      this.#heldBy = null;
      return false;
    }

    this.#heldBy = row.pid;
    return true;
  }

  async release(): Promise<void> {
    // Nothing to give up, and `pg_advisory_unlock` on a lock this session does not hold merely
    // warns — but a process that never swept should not be issuing statements about it at all.
    if (this.#heldBy === null) return;

    // Forgotten only once the database has agreed, which is the opposite order to the obvious one:
    // an unlock that failed leaves this session still holding the lock, and a `#heldBy` cleared
    // ahead of it would have the next `held()` take it a second time and stack it one deep — the
    // exact state the pid is remembered to avoid.
    await this.#sql`select pg_advisory_unlock(hashtext(${this.#name}))`;
    this.#heldBy = null;
  }
}
