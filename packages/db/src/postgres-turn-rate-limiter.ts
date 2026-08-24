/**
 * The turn allowance, enforced in Postgres — one window per person, whatever is serving them.
 *
 * A `Map` in the process is a correct sliding window and the wrong place for one: two replicas
 * mean two independent allowances, so the free-tier ceiling that makes an open demo door
 * affordable silently multiplies by the replica count. The window moves into a table, and the
 * three properties the in-process version was careful about move with it — see
 * `@nap/shared/ports/turn-rate-limit` for what they are and why each is load-bearing.
 *
 * **The database's clock, everywhere.** Every timestamp is written by `now()` and every comparison
 * is made against it inside the same statement, so the window never depends on whose replica
 * answered or how far its clock has drifted. It is also why `retryAfterSeconds` is computed in SQL
 * rather than from a `Date` the driver handed back: the subtraction and the reading of the clock
 * then happen in one place at one instant.
 *
 * **Counted and recorded inside one transaction, under an advisory lock.** Counting and then
 * inserting are not one operation: two admissions at the boundary would both read `limit - 1`,
 * both decide there was room, and both insert. The lock is the idiom `PostgresSandboxCapacity`
 * and `PostgresEventStore.append` already use, and cluster-wide for the same reason — it lives in
 * the database, so a second API process is serialized against the first rather than counting in
 * parallel with it. Keyed per user and tier, unlike the capacity lock, because the count this one
 * protects is over one person's rows: two different people admitting at once are deciding
 * independent questions and have no reason to queue behind each other.
 */

import type { RateDecision, TurnRateLimiter } from "@nap/shared/ports/turn-rate-limit";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export type TurnRateLimit = {
  /** Turns allowed inside one window. */
  limit: number;
  windowMs: number;
  /**
   * Which allowance this is. Two instances, never one shared: the window is per tier as well as
   * per user, or somebody's paid turns would eat their free allowance.
   */
  tier: "free" | "paid";
};

export class PostgresTurnRateLimiter implements TurnRateLimiter {
  readonly #db: PostgresJsDatabase;
  readonly #limit: TurnRateLimit;

  /** Takes a database rather than a URL, for the reason `PostgresEventStore` does. */
  constructor(db: PostgresJsDatabase, limit: TurnRateLimit) {
    this.#db = db;
    this.#limit = limit;
  }

  async check(userId: string): Promise<RateDecision> {
    const { tier } = this.#limit;
    const window = this.#window();

    return await this.#db.transaction(async (tx) => {
      // Held until this transaction ends, so the count below and the insert that depends on it
      // cannot be interleaved with another admission for the same person and tier.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`nap:turn-rate:${tier}:${userId}`}))`,
      );

      // One statement for both answers. `wait` is null when nothing is in the window, which is
      // exactly the case where it is not read — and it is the whole seconds until the *oldest*
      // row inside the window leaves it, which is when a slot opens.
      const [state] = await tx.execute<{ used: number; wait: number | null }>(sql`
        select
          count(*)::int as used,
          ceil(extract(epoch from (min(at) + ${window}::interval - now())))::int as wait
        from turn_rate_events
        where user_id = ${userId}::uuid
          and tier = ${tier}
          and at > now() - ${window}::interval
      `);

      const used = Number(state?.used ?? 0);

      if (used >= this.#limit.limit) {
        // Nothing is written on this path, which is the property the whole design turns on.
        // `wait` cannot be null here — a row was counted — but a floor of one second is right
        // regardless: `Retry-After: 0` invites an immediate, futile retry.
        return { allowed: false, retryAfterSeconds: Math.max(1, Number(state?.wait ?? 1)) };
      }

      await tx.execute(sql`
        insert into turn_rate_events (user_id, tier) values (${userId}::uuid, ${tier})
      `);

      return { allowed: true };
    });
  }

  /**
   * Deletes every row of this tier that has left the window.
   *
   * No lock: a row past the cutoff can never be counted again, so removing it cannot change any
   * admission's answer, and an admission running concurrently is reading rows this will not
   * touch. Scoped to this tier because the two limiters are two independent windows and may one
   * day be two different lengths — sweeping the whole table from either would make one limiter's
   * configuration silently govern the other's rows.
   */
  async sweep(): Promise<number> {
    const window = this.#window();

    const deleted = await this.#db.execute(sql`
      delete from turn_rate_events
      where tier = ${this.#limit.tier} and at <= now() - ${window}::interval
    `);

    // postgres.js reports the affected-row count on the result array itself.
    return deleted.count;
  }

  /** The window as something Postgres can subtract, in the unit the configuration is written in. */
  #window(): string {
    return `${this.#limit.windowMs} milliseconds`;
  }
}
