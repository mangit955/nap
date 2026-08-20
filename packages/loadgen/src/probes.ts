/**
 * The two arithmetic questions `docs/scaling-design.md` §24 leaves open for the baseline run.
 *
 * Both are measurements a run collects and neither is one anybody can read without something to
 * read it against, which is what this file supplies:
 *
 *   - **item 4, `hashtext` collisions.** `pg_advisory_xact_lock(hashtext(session_id))` maps
 *     uuids into int4, so two unrelated sessions can serialize on one lock. A collision count
 *     from a run means nothing on its own — the question is whether it is more than chance —
 *     so the report carries the birthday expectation beside it.
 *   - **item 2, catch-up poll cost.** Whether polling every session independently is affordable
 *     is a rate and a share of a connection, not a feeling, and the comparison against the
 *     batched design is the whole point of asking.
 *
 * Pure, because both numbers go into a document people will make a scaling decision from.
 */

/** What `hashtext` maps into: a signed 32-bit integer, so 2^32 distinct values. */
export const INT4_SPACE = 2 ** 32;

export type CollisionReport = {
  ids: number;
  distinctHashes: number;
  /** How many ids share their hash with at least one other. Sessions, not groups. */
  collidingIds: number;
  /** The most ids on any one hash — the worst serialization a single lock would cause. */
  largestGroup: number;
  /** What chance alone predicts, C(n,2)/space, so the observed count is readable. */
  expectedCollidingPairs: number;
};

export function hashCollisions(hashes: readonly number[], space = INT4_SPACE): CollisionReport {
  const groups = new Map<number, number>();
  for (const hash of hashes) groups.set(hash, (groups.get(hash) ?? 0) + 1);

  let collidingIds = 0;
  let largestGroup = 0;
  for (const size of groups.values()) {
    if (size > 1) collidingIds += size;
    largestGroup = Math.max(largestGroup, size);
  }

  const n = hashes.length;

  return {
    ids: n,
    distinctHashes: groups.size,
    collidingIds,
    largestGroup,
    expectedCollidingPairs: (n * (n - 1)) / 2 / space,
  };
}

export type PollCostInput = {
  /** Queries issued each tick — the session count when each is polled on its own, else 1. */
  queriesPerTick: number;
  tickIntervalMs: number;
  /** What one such query costs, measured against a populated database. */
  perQueryMs: number;
};

export type PollCost = {
  queriesPerSecond: number;
  /**
   * The share of one database connection the polling occupies. Above 1 means the poll alone
   * needs more than one connection permanently, before any user request is served.
   */
  busyFraction: number;
};

export function pollCost(input: PollCostInput): PollCost {
  if (input.tickIntervalMs <= 0) {
    throw new RangeError("a poll interval of zero is not a rate");
  }

  const queriesPerSecond = input.queriesPerTick / (input.tickIntervalMs / 1_000);

  return {
    queriesPerSecond,
    busyFraction: (queriesPerSecond * input.perQueryMs) / 1_000,
  };
}
