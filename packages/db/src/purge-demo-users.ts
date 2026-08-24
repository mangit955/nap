/**
 * Collecting the throwaway identities a load run leaves behind.
 *
 * `docs/scaling-design.md` §24 item 6: the demo door is the only path k6 can drive without OAuth,
 * so a ramp to 100 signs in a hundred anonymous users, each with a project, a session and every
 * event of every turn it ran. Nothing else in the system expires them — the reaper puts an idle
 * project's *sandbox* away and deliberately leaves the row, because a project is somebody's work
 * and the snapshot is how it comes back. For a demo identity that never returns, that is a
 * permanent population growing by a hundred a run, in the table real accounts live in.
 *
 * **Age is the tenancy.** The alternative was a test-only tenant — a flag on the user, a separate
 * database — and it was not taken: the whole value of driving the demo door is that k6 goes
 * through the *real* admission path, and a load-test-only branch in it is the one code path a load
 * test would then never exercise. What separates a run's hundred users from the person trying the
 * product right now is that the run finished an hour ago.
 *
 * Two rules keep it from taking something it should not, and both are `where` clauses rather than
 * conventions: never a registered account, and never somebody whose turn is still going.
 */

import { and, eq, inArray, lt, notExists, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { projects, turnRequests, users } from "./schema.ts";

/** The states that mean work is owed: a queued request will be claimed, a leased one is running. */
const IN_FLIGHT = ["queued", "leased"] as const;

export type PurgeDemoUsersOptions = {
  /** How long an identity must have been idle-eligible. A run's users are minutes old. */
  olderThanMinutes: number;
  /**
   * How many to take in one pass, so a first run against a database with a year of them is a
   * decision rather than a long transaction holding locks on the users table.
   */
  limit?: number;
  /** Selects and reports, deletes nothing. What `--dry-run` passes. */
  dryRun?: boolean;
};

export type PurgedDemoUsers = {
  /** The identities deleted, or — under `dryRun` — the ones that would have been. */
  userIds: string[];
  /** How many projects went with them, for the line the script prints. */
  projectCount: number;
  /**
   * Sandboxes that were still named by a deleted project.
   *
   * Nothing here can destroy one, and once the project row is gone nothing else will either:
   * the reaper deliberately leaves a sandbox whose project this database does not know, so that
   * a benchmark run on the same E2B account is not killed by somebody's tidy-up. So they
   * are handed back, and `apps/api/scripts/loadgen-teardown.ts` is what acts on them.
   */
  orphanedSandboxIds: string[];
};

const DEFAULT_LIMIT = 500;

export async function purgeDemoUsers(
  db: PostgresJsDatabase,
  options: PurgeDemoUsersOptions,
): Promise<PurgedDemoUsers> {
  const olderThan = sql`now() - ${`${options.olderThanMinutes} minutes`}::interval`;

  /**
   * Never a registered account, never somebody mid-turn.
   *
   * The second clause is not politeness: deleting a session out from under an executing turn is
   * a worker appending events to a row that no longer exists, which fails a foreign key in the
   * middle of somebody's work rather than tidily. Waiting costs nothing — the sweep repeats, and
   * the request reaches a terminal state within `lease_ttl + grace` by invariant 14.
   */
  const eligible = and(
    eq(users.isAnonymous, true),
    lt(users.createdAt, olderThan),
    notExists(
      db
        .select({ one: sql`1` })
        .from(turnRequests)
        .where(and(eq(turnRequests.userId, users.id), inArray(turnRequests.state, [...IN_FLIGHT]))),
    ),
  );

  return await db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: users.id })
      .from(users)
      .where(eligible)
      .orderBy(users.createdAt)
      .limit(options.limit ?? DEFAULT_LIMIT);
    const candidateIds = candidates.map((row) => row.id);
    if (candidateIds.length === 0) {
      return { userIds: [], projectCount: 0, orphanedSandboxIds: [] };
    }

    // Read before the delete, because the cascade is what takes these rows away and afterwards
    // there is nothing left to ask which sandboxes they named.
    const owned = await tx
      .select({ userId: projects.userId, sandboxId: projects.sandboxId })
      .from(projects)
      .where(inArray(projects.userId, candidateIds));

    if (options.dryRun === true) {
      return {
        userIds: candidateIds,
        projectCount: owned.length,
        orphanedSandboxIds: owned
          .map((row) => row.sandboxId)
          .filter((id): id is string => id !== null),
      };
    }

    // The predicate is repeated on the delete rather than trusted from the select above: a turn
    // admitted in between would otherwise be executing against a session this statement is about
    // to remove. Restating it is what makes the two reads one decision.
    const deleted = await tx
      .delete(users)
      .where(and(inArray(users.id, candidateIds), eligible))
      .returning({ id: users.id });
    const deletedIds = new Set(deleted.map((row) => row.id));

    const survived = owned.filter((row) => deletedIds.has(row.userId));
    return {
      userIds: [...deletedIds],
      projectCount: survived.length,
      orphanedSandboxIds: survived
        .map((row) => row.sandboxId)
        .filter((id): id is string => id !== null),
    };
  });
}
