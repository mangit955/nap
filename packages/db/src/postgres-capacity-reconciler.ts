/**
 * The sweep half of the sandbox ceiling: the rows nothing gave back, found and deleted.
 *
 * Every path that runs to the end releases what it reserved. What is left over is the paths that
 * did not — a process killed between reserving and creating, a `sessions.setSandboxId` that never
 * landed, a provider reclaiming a sandbox on its own timer — and each of those holds a slot of the
 * only limit bounding this deployment's E2B bill. None of them heals on its own, so without this
 * a ceiling of ten becomes a ceiling of nine, permanently, the first time a pod is restarted at
 * the wrong moment.
 *
 * **Two rules, and the grace window on both is the interesting part.** A `reserved` row is
 * reclaimed once `expires_at` has passed, which is what that column has always been for. An
 * `active` row is reclaimed once nothing names its sandbox — but only once the row is old enough
 * that it cannot be an acquire still in flight: a sandbox is activated a moment *before* the
 * project row is updated to name it, so a reclamation with no grace would occasionally delete the
 * reservation of a sandbox that is about to be perfectly healthy, and the ceiling would then be
 * counting one fewer than really exists. Erring towards leaving a row costs minutes of one slot;
 * erring the other way silently raises the cap.
 *
 * Separate from `PostgresSandboxCapacity` because it answers a different port for a different
 * caller — see `CapacityReconciler` — and because it reads the projects table, which admission
 * never does.
 */

import { STRANDED_GRACE_MS } from "@nap/shared/capacity-windows";
import type { CapacityReconciler, ReclaimedCapacity } from "@nap/shared/ports/capacity-reconciler";
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { projects, sandboxReservations } from "./schema.ts";

/**
 * How old an `active` row must be before "nothing names its sandbox" is believed, as an interval.
 *
 * An acquire activates its reservation and then writes the sandbox id onto the project, and for
 * the moment between the two the row looks exactly like a leak. The number is
 * `STRANDED_GRACE_MS`, shared with the sweep that destroys the sandboxes themselves so the two
 * cannot come to different conclusions about the same acquire.
 */
const ACTIVATION_GRACE = `${STRANDED_GRACE_MS} milliseconds`;

export class PostgresCapacityReconciler implements CapacityReconciler {
  readonly #db: PostgresJsDatabase;

  /** Takes a database rather than a URL, for the reason `PostgresEventStore` does. */
  constructor(db: PostgresJsDatabase) {
    this.#db = db;
  }

  async reclaimStranded(): Promise<ReclaimedCapacity> {
    // Two statements rather than one with an `or`: they are different rules about different
    // states, and a single predicate holding both would be unreadable and untestable apart.
    // No transaction and no lock — each row is deleted or it is not, and a reservation being
    // taken concurrently is by definition neither expired nor unreferenced.
    const expired = await this.#db
      .delete(sandboxReservations)
      .where(
        and(
          eq(sandboxReservations.state, "reserved"),
          lt(sandboxReservations.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: sandboxReservations.id });

    const orphaned = await this.#db
      .delete(sandboxReservations)
      .where(
        and(
          eq(sandboxReservations.state, "active"),
          lt(sandboxReservations.createdAt, sql`now() - ${ACTIVATION_GRACE}::interval`),
          // A row that names nothing while claiming to be active is stranded by definition:
          // there is no sandbox anybody could ever match it to.
          sql`(${sandboxReservations.sandboxId} is null or not exists (
            select 1 from ${projects} where ${projects.sandboxId} = ${sandboxReservations.sandboxId}
          ))`,
        ),
      )
      .returning({ id: sandboxReservations.id });

    return { expired: expired.map((row) => row.id), orphaned: orphaned.map((row) => row.id) };
  }

  async referencedSandboxIds(): Promise<string[]> {
    // Reservations as well as projects, deliberately: an acquire that has activated its row but
    // not yet written the id onto the project is a live sandbox that the projects table alone
    // would call unreferenced. Whoever consumes this destroys what is missing from it, so the
    // set has to err wide.
    //
    // Two typed queries and a `Set` rather than one `union` in raw SQL. The union would be one
    // round trip, but it costs the schema-derived row type — and this is the query whose being
    // wrong destroys somebody's workspace, so the version the compiler checks wins.
    const [held, reserved] = await Promise.all([
      this.#db
        .select({ sandboxId: projects.sandboxId })
        .from(projects)
        .where(isNotNull(projects.sandboxId)),
      this.#db
        .select({ sandboxId: sandboxReservations.sandboxId })
        .from(sandboxReservations)
        .where(isNotNull(sandboxReservations.sandboxId)),
    ]);

    const referenced = new Set<string>();
    for (const row of [...held, ...reserved]) {
      // The `where` above guarantees this; the columns are nullable in general.
      if (row.sandboxId !== null) referenced.add(row.sandboxId);
    }

    return [...referenced];
  }

  async knownProjectIds(projectIds: string[]): Promise<string[]> {
    // `inArray` with an empty list is a SQL syntax error in some drivers and a query nobody
    // needed in any of them.
    if (projectIds.length === 0) return [];

    const rows = await this.#db
      .select({ id: projects.id })
      .from(projects)
      .where(inArray(projects.id, projectIds));

    return rows.map((row) => row.id);
  }
}
