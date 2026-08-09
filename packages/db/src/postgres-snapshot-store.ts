/**
 * The snapshots table, behind the `SnapshotStore` port.
 *
 * One row per teardown: which project, which object-storage key, and the commit that key
 * captured. Rows accumulate rather than being replaced — the newest is what a restore reads,
 * and the older ones are what makes it possible to notice that a project has been torn down
 * and reopened many times. Pruning them is a decision nothing has needed to make yet.
 *
 * `createdAt` is mapped to an ISO string on the way out for the same reason events are: the
 * column is `timestamptz` and the driver hands back a `Date`, while every contract above this
 * layer speaks strings.
 */

import type { NewSnapshot, SnapshotRecord, SnapshotStore } from "@nap/shared/ports/snapshot-store";
import { desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { snapshots } from "./schema.ts";

type SnapshotRow = typeof snapshots.$inferSelect;

function toRecord(row: SnapshotRow): SnapshotRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    key: row.r2Key,
    gitSha: row.gitSha,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PostgresSnapshotStore implements SnapshotStore {
  readonly #db: PostgresJsDatabase;

  constructor(db: PostgresJsDatabase) {
    this.#db = db;
  }

  async record(snapshot: NewSnapshot): Promise<SnapshotRecord> {
    const [row] = await this.#db
      .insert(snapshots)
      .values({
        projectId: snapshot.projectId,
        r2Key: snapshot.key,
        gitSha: snapshot.gitSha,
      })
      .returning();

    // Postgres cannot return zero rows from a single-row insert; a missing row here would
    // mean the driver contract changed underneath us.
    if (row === undefined) throw new Error("insert into snapshots returned no row");
    return toRecord(row);
  }

  async latestFor(projectId: string): Promise<SnapshotRecord | null> {
    // Ordered by `created_at` and then `id`, because two snapshots of the same project can
    // land in the same millisecond and "the newest" would otherwise be whichever the planner
    // felt like returning.
    const [row] = await this.#db
      .select()
      .from(snapshots)
      .where(eq(snapshots.projectId, projectId))
      .orderBy(desc(snapshots.createdAt), desc(snapshots.id))
      .limit(1);

    return row === undefined ? null : toRecord(row);
  }

  async listFor(projectId: string): Promise<SnapshotRecord[]> {
    const rows = await this.#db
      .select()
      .from(snapshots)
      .where(eq(snapshots.projectId, projectId))
      .orderBy(desc(snapshots.createdAt), desc(snapshots.id));

    return rows.map(toRecord);
  }
}
