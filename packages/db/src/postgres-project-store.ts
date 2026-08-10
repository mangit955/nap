/**
 * The projects somebody has, backed by Postgres.
 *
 * Two things here are the database's job rather than this class's, and both are worth knowing.
 * The listing's order comes from `projects.updated_at`, which every write to a project touches
 * — creating one, recording its sandbox, putting it away — so "most recent activity" needs no
 * separate bookkeeping. And **deleting a project deletes its sessions, its events and its
 * snapshot rows through `on delete cascade`**, declared in `schema.ts`: this issues one
 * statement and the referential integrity does the rest, which is the only version of that
 * operation nothing can half-finish.
 *
 * What it deliberately does *not* delete is the objects those snapshot rows point at. They are
 * in another system that can fail on its own, and the rows are the only record of their keys —
 * so whatever removes them has to run first, and has to be able to see both.
 */

import type { ProjectStatus, ProjectStore, ProjectSummary } from "@nap/shared/ports/project-store";
import { and, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { projects, sessions } from "./schema.ts";

type Row = {
  projectId: string;
  name: string;
  status: ProjectStatus;
  sandboxId: string | null;
  updatedAt: Date;
  sessionIds: (string | null)[];
};

export class PostgresProjectStore implements ProjectStore {
  readonly #db: PostgresJsDatabase;

  /** Takes a database rather than a URL, for the reason `PostgresEventStore` does. */
  constructor(db: PostgresJsDatabase) {
    this.#db = db;
  }

  async list(userId: string): Promise<ProjectSummary[]> {
    const rows = await this.#select()
      .where(eq(projects.userId, userId))
      .orderBy(desc(projects.updatedAt), desc(projects.id));

    return rows.map(toSummary);
  }

  async get(projectId: string, userId: string): Promise<ProjectSummary | null> {
    // The owner is part of the lookup rather than checked afterwards, so somebody else's project
    // is indistinguishable here from one that was never there. A caller cannot accidentally read
    // the row first and forget to compare.
    const [row] = await this.#select()
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1);

    return row === undefined ? null : toSummary(row);
  }

  async delete(projectId: string, userId: string): Promise<boolean> {
    const deleted = await this.#db
      .delete(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .returning({ id: projects.id });

    return deleted.length > 0;
  }

  /**
   * A left join, so a project with no conversation in it still appears — it is a row somebody
   * can see and delete, and dropping it from the listing would leave something that exists and
   * cannot be reached. Sessions come back newest first from one aggregate rather than a second
   * query per project.
   */
  #select() {
    return this.#db
      .select({
        projectId: projects.id,
        name: projects.name,
        status: projects.status,
        sandboxId: projects.sandboxId,
        updatedAt: projects.updatedAt,
        // `filter` because the left join produces a null row for a project with no sessions,
        // and `array_agg` would otherwise hand back `[null]` rather than an empty list.
        sessionIds: sql<
          string[]
        >`coalesce(array_agg(${sessions.id} order by ${sessions.createdAt} desc) filter (where ${sessions.id} is not null), '{}')`,
      })
      .from(projects)
      .leftJoin(sessions, eq(sessions.projectId, projects.id))
      .groupBy(projects.id)
      .$dynamic();
  }
}

function toSummary(row: Row): ProjectSummary {
  return {
    projectId: row.projectId,
    name: row.name,
    status: row.status,
    sandboxId: row.sandboxId,
    // `timestamptz` comes back as a Date; every contract in this codebase carries ISO strings.
    updatedAt: row.updatedAt.toISOString(),
    sessionIds: row.sessionIds.filter((id): id is string => id !== null),
  };
}
