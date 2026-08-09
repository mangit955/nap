/**
 * A `SnapshotStore` holding rows in an array.
 *
 * Teardown's ordering rule — bundle, upload, row, and only then destroy — is asserted by
 * tests that have no business starting a database, so the row half of it needs a fake the way
 * the byte half does.
 *
 * `failWith` exists for the same reason it does on the object-store fake: the row write can
 * fail on its own, and a sandbox destroyed after that failure has taken the project with it.
 *
 * Records are handed back as copies, and `createdAt` is generated in strictly increasing
 * order rather than from the clock — two snapshots written in the same millisecond would
 * otherwise make "the newest" ambiguous here while the Postgres store breaks the tie.
 */

import type { NewSnapshot, SnapshotRecord, SnapshotStore } from "@nap/shared/ports/snapshot-store";

export class InMemorySnapshotStore implements SnapshotStore {
  readonly #rows: SnapshotRecord[] = [];
  #failure: Error | undefined;
  #sequence = 0;

  /** Makes every write fail until called again with `undefined`. */
  failWith(error: Error | undefined): this {
    this.#failure = error;
    return this;
  }

  /** Every row written, oldest first — what an ordering assertion reads. */
  all(): SnapshotRecord[] {
    return this.#rows.map((row) => ({ ...row }));
  }

  async record(snapshot: NewSnapshot): Promise<SnapshotRecord> {
    // Thrown, not returned: the port's `record` promises a record, and a database being
    // unreachable is not an outcome this interface models.
    if (this.#failure !== undefined) throw this.#failure;

    this.#sequence += 1;
    const row: SnapshotRecord = {
      id: `snapshot-${this.#sequence}`,
      projectId: snapshot.projectId,
      key: snapshot.key,
      gitSha: snapshot.gitSha,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, this.#sequence)).toISOString(),
    };

    this.#rows.push(row);
    return { ...row };
  }

  async latestFor(projectId: string): Promise<SnapshotRecord | null> {
    const found = this.#rows.filter((row) => row.projectId === projectId).at(-1);
    return found === undefined ? null : { ...found };
  }

  async listFor(projectId: string): Promise<SnapshotRecord[]> {
    return this.#rows
      .filter((row) => row.projectId === projectId)
      .map((row) => ({ ...row }))
      .reverse();
  }
}
