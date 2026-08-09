/**
 * Which projects are holding a sandbox, backed by Postgres.
 *
 * **Idleness is derived, not stored.** A project's last activity is the newest event in any of
 * its sessions, floored by the project row's own `updated_at` so that a project with a sandbox
 * and an empty log — a first turn that failed after acquiring one — still has an age. The
 * alternative, a `last_active_at` column bumped by the runtime, is a second source of truth
 * that is wrong the first time a code path forgets to write it, and the event log cannot
 * forget: writing events is what a turn *is*.
 *
 * One query per sweep rather than one per project. There are only ever as many candidates as
 * there are running sandboxes, and the aggregate is what lets the reaper hold no state at all
 * between ticks.
 */

import type { IdleProject, ProjectSandboxStore } from "@nap/shared/ports/project-sandbox-store";
import { eq, isNotNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { events, projects, sessions } from "./schema.ts";

export class PostgresProjectSandboxStore implements ProjectSandboxStore {
  readonly #db: PostgresJsDatabase;

  /** Takes a database rather than a URL, for the reason `PostgresEventStore` does. */
  constructor(db: PostgresJsDatabase) {
    this.#db = db;
  }

  async idleSince(cutoff: string): Promise<IdleProject[]> {
    const rows = await this.#db
      .select({
        projectId: projects.id,
        sandboxId: projects.sandboxId,
        // `filter` because the outer joins produce a null row for a project with no sessions,
        // and `array_agg` would otherwise hand back `[null]` rather than an empty list.
        sessionIds: sql<
          string[]
        >`coalesce(array_agg(distinct ${sessions.id}) filter (where ${sessions.id} is not null), '{}')`,
        lastActiveAt: sql<Date>`greatest(${projects.updatedAt}, max(${events.createdAt}))`,
      })
      .from(projects)
      .leftJoin(sessions, eq(sessions.projectId, projects.id))
      .leftJoin(events, eq(events.sessionId, sessions.id))
      .where(isNotNull(projects.sandboxId))
      .groupBy(projects.id)
      // Filtered after the aggregate, because the value being compared is one.
      .having(
        sql`greatest(${projects.updatedAt}, max(${events.createdAt})) < ${cutoff}::timestamptz`,
      );

    return rows.map((row) => ({
      projectId: row.projectId,
      // The `where` above guarantees this; the column is nullable in general.
      sandboxId: row.sandboxId ?? "",
      sessionIds: row.sessionIds,
      lastActiveAt: new Date(row.lastActiveAt).toISOString(),
    }));
  }

  async releaseSandbox(projectId: string, snapshotKey: string | null): Promise<void> {
    const updated = await this.#db
      .update(projects)
      .set({
        // The point of the whole operation: the next turn must restore rather than try to
        // resume something that no longer exists.
        sandboxId: null,
        // A null key means nothing new was captured, so the column keeps what it had — that
        // row may be pointing at the last surviving copy of the project.
        ...(snapshotKey === null ? {} : { snapshotKey }),
        status: "idle",
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId))
      .returning({ id: projects.id });

    // Thrown rather than returned, like `PostgresSessionStore.setSandboxId`: the caller has
    // just been handed this project by `idleSince`, so getting here means something deleted it
    // underneath us, which nothing above could act on.
    if (updated.length === 0) throw new Error(`unknown project ${projectId}`);
  }
}
