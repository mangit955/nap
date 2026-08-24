/**
 * The sandbox ceiling, enforced in Postgres — the only thing bounding this deployment's E2B bill.
 *
 * The whole difficulty is that admission used to be count-then-create. Two counts and a creation
 * are not one operation, so a hundred simultaneous admissions all read the same number, all found
 * themselves under the limit, and the cap of ten bought a hundred sandboxes. Here the counts and
 * the insert happen inside one transaction holding `pg_advisory_xact_lock` — the idiom
 * `PostgresEventStore.append` already uses, and cluster-wide for the same reason: the lock lives
 * in the database, so a second API process is serialized against the first rather than counting
 * in parallel with it.
 *
 * **Three transactions, deliberately, and the first one commits before anything is created.**
 * Reserving takes the lock, counts, inserts and commits — sub-millisecond, and a burst of a
 * hundred clears in well under a second, invisible beside a three-second sandbox cold start.
 * Only then is the provider called, with no lock held for those seconds. Activating and releasing
 * are each a single statement and take no lock at all: they change one known row and cannot
 * affect anybody else's decision, because capacity was already spent at reservation.
 *
 * The consequence is that the cap is enforced on the *reservation* rather than on the sandbox, so
 * it can never be exceeded and can only ever be temporarily under-used — the right direction for
 * a limit whose job is to cap a bill.
 *
 * **A stranded row holds capacity until something reclaims it.** A process that dies between
 * reserving and creating leaves a `reserved` row nobody will ever release, which is what
 * `expires_at` is for; nothing here reads that column, because reclaiming is a sweep's job rather
 * than an admission's. That sweep is `PostgresCapacityReconciler`, run by the reaper, so a crash
 * mid-creation costs one slot for minutes rather than forever.
 */

import { RESERVATION_TTL_MS } from "@nap/shared/capacity-windows";
import type {
  ActivationFailure,
  CapacityRefusal,
  Reservation,
  SandboxCapacity,
} from "@nap/shared/ports/sandbox-capacity";
import type { Result, VoidResult } from "@nap/shared/result";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sandboxReservations } from "./schema.ts";

/**
 * What a reservation may cost this deployment before it is used, as a Postgres interval.
 *
 * The number itself lives in `@nap/shared/capacity-windows` beside the window the reclaiming
 * sweep waits, because the two have to agree and a constant in each file would drift.
 */
const RESERVATION_TTL = `${RESERVATION_TTL_MS} milliseconds`;

/**
 * The one lock every admission contends on, whichever project or process it is for.
 *
 * A per-project or per-user key would serialize the wrong thing: the count being protected is
 * over every row in the table, so two admissions for different users must still not read it at
 * the same moment. `hashtext` of a fixed string, rather than a magic number, so the value is
 * derivable from something a reader can search for.
 */
const CAPACITY_LOCK = "nap:sandbox-capacity";

/** Both states occupy capacity: a creation in flight has already been paid for. */
const OCCUPIED = ["reserved", "active"] as const;

export type CapacityLimits = {
  /** How many sandboxes one person may hold at once. */
  perUser: number;
  /** How many exist at once across everybody, in every process talking to this database. */
  total: number;
};

export class PostgresSandboxCapacity implements SandboxCapacity {
  readonly #db: PostgresJsDatabase;
  readonly #limits: CapacityLimits;

  /**
   * Takes a database rather than a URL, for the reason `PostgresEventStore` does — and takes the
   * limits, because the caller that reserves is inside the runtime and has no business knowing
   * what a deployment is willing to spend.
   */
  constructor(db: PostgresJsDatabase, limits: CapacityLimits) {
    this.#db = db;
    this.#limits = limits;
  }

  async reserve(request: {
    projectId: string;
    userId: string;
  }): Promise<Result<Reservation, CapacityRefusal>> {
    const { projectId, userId } = request;

    return await this.#db.transaction(async (tx) => {
      // Held until this transaction ends, so the counts below and the insert that depends on
      // them cannot be interleaved with another admission's.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${CAPACITY_LOCK}))`);

      // What this project already holds, if anything, decided before the counts are read: a
      // project with a row is not asking for capacity, it is asking for the slot it has.
      const [existing] = await tx
        .select({
          id: sandboxReservations.id,
          state: sandboxReservations.state,
          stillCreating: sql<boolean>`${sandboxReservations.expiresAt} > now()`,
        })
        .from(sandboxReservations)
        .where(
          and(
            eq(sandboxReservations.projectId, projectId),
            inArray(sandboxReservations.state, [...OCCUPIED]),
          ),
        );

      if (existing !== undefined) {
        // Somebody else is creating this project's sandbox *right now*. Refused rather than
        // joined: two callers each believing they own the creation is how a project ends up with
        // two sandboxes, one of which nothing references and nobody stops paying for. Bounded by
        // the reservation's own expiry, so this can only be answered for a couple of minutes.
        if (existing.state === "reserved" && existing.stillCreating) {
          return refuse(
            "project_held",
            "This project is already opening a sandbox. Wait for that to finish and try again.",
          );
        }

        // Otherwise the row is stale and the slot is this project's to reuse. An `active` row
        // means a sandbox was created and recorded — and the caller only reaches here when there
        // is no usable sandbox, so that one is gone, reclaimed by the provider behind our back.
        // Refusing would leave the project unable to restore from its own snapshot until a sweep
        // came past, which is the one path where a mistake loses somebody's work. Reusing the row
        // rather than inserting a second keeps the count honest: the project held one slot before
        // and holds one now.
        await tx
          .update(sandboxReservations)
          .set({
            state: "reserved",
            sandboxId: null,
            expiresAt: sql`now() + ${RESERVATION_TTL}::interval`,
          })
          .where(eq(sandboxReservations.id, existing.id));

        return { ok: true as const, value: { id: existing.id } };
      }

      // One statement for both counts: a second round trip inside the critical section would be
      // a second network wait every other admission in the cluster is queued behind.
      const [counts] = await tx
        .select({
          mine: sql<number>`count(*) filter (where ${sandboxReservations.userId} = ${userId}::uuid)`,
          everyone: sql<number>`count(*)`,
        })
        .from(sandboxReservations)
        .where(inArray(sandboxReservations.state, [...OCCUPIED]));

      const mine = Number(counts?.mine ?? 0);
      const everyone = Number(counts?.everyone ?? 0);

      // Checked before the global ceiling deliberately, as the route's advisory check is: when
      // both are full, the useful thing to say is the one the person asking can act on.
      if (mine >= this.#limits.perUser) {
        return refuse(
          "per_user",
          `You already have ${mine} project${mine === 1 ? "" : "s"} running, which is the limit. ` +
            "Close one from the project list and try again.",
        );
      }

      if (everyone >= this.#limits.total) {
        return refuse(
          "total",
          "This server is at its limit of running projects. Try again in a few minutes.",
        );
      }

      const [row] = await tx
        .insert(sandboxReservations)
        .values({
          projectId,
          userId,
          state: "reserved",
          expiresAt: sql`now() + ${RESERVATION_TTL}::interval`,
        })
        .returning({ id: sandboxReservations.id });

      // Postgres cannot return zero rows from a single-row insert; a missing row here would mean
      // the driver contract changed under us.
      if (row === undefined) throw new Error("insert into sandbox_reservations returned no row");
      return { ok: true as const, value: { id: row.id } };
    });
  }

  /**
   * **The rowcount is the whole point.** A creation slower than `RESERVATION_TTL` comes back to
   * find the reclaiming sweep has already deleted its row — no crash and no concurrency needed,
   * one slow cold start is enough. The update then matches nothing, and reporting that as success
   * would leave a real, running, billed sandbox that no row counts: a sandbox outside the ceiling,
   * which is the only thing bounding this deployment's bill.
   *
   * It deliberately does not re-insert. The slot was given back and may already have been handed
   * to somebody else, so recreating the row would count one slot twice; whoever is holding the
   * sandbox is the only one who can put it right, which is why this answers rather than throws.
   */
  async activate(reservationId: string, sandboxId: string): Promise<VoidResult<ActivationFailure>> {
    const rows = await this.#db
      .update(sandboxReservations)
      .set({
        state: "active",
        sandboxId,
        // Nothing is waiting on this row any more, so nothing should reclaim it on a timer: it
        // is released by the teardown that destroys the sandbox it names.
        expiresAt: sql`'infinity'`,
      })
      .where(eq(sandboxReservations.id, reservationId))
      .returning({ id: sandboxReservations.id });

    if (rows.length === 0) return reclaimed(sandboxId);
    return { ok: true, value: undefined };
  }

  /**
   * Deleting rather than marking, in both releases, and finding nothing is success.
   *
   * A released reservation has nothing left to say — the sandbox it named is gone, or was never
   * created — and a row kept for history would have to be excluded from every count and from the
   * partial unique index that stops one project being admitted twice. Silence when there is no
   * row is what makes a close racing the reaper harmless: whichever arrives second deletes
   * nothing and reports nothing, rather than failing a teardown over bookkeeping.
   */
  async release(reservationId: string): Promise<void> {
    await this.#db.delete(sandboxReservations).where(eq(sandboxReservations.id, reservationId));
  }

  async releaseForProject(projectId: string): Promise<void> {
    await this.#db
      .delete(sandboxReservations)
      .where(
        and(
          eq(sandboxReservations.projectId, projectId),
          inArray(sandboxReservations.state, [...OCCUPIED]),
        ),
      );
  }
}

function refuse(
  reason: CapacityRefusal["reason"],
  message: string,
): Result<never, CapacityRefusal> {
  return { ok: false, error: { reason, message } };
}

/** Named for whoever reads the log line: it says which sandbox nothing is counting. */
function reclaimed(sandboxId: string): VoidResult<ActivationFailure> {
  return {
    ok: false,
    error: {
      reason: "reservation_reclaimed",
      message:
        `The reservation this deployment's ceiling was holding for sandbox ${sandboxId} was ` +
        "reclaimed while it was being created, so nothing is counting it.",
    },
  };
}
