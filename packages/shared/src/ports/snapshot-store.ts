/**
 * The record of which bundle holds which project, and at what commit.
 *
 * The bundle itself lives in object storage under a key; this is the row that says the key
 * exists, which project it belongs to and what git sha it captured. Two things need it:
 * teardown writes one, and opening a project reads the most recent one to restore from.
 *
 * Separate from `ObjectStore` on purpose. The bytes and the bookkeeping fail independently —
 * an upload can succeed while the database is unreachable — and keeping them apart is what
 * lets the ordering rule be stated at all: bytes first, row second, destroy last. A single
 * combined interface would hide the window that rule exists to close.
 */

export type SnapshotRecord = {
  id: string;
  projectId: string;
  /** Where the bundle is in object storage. */
  key: string;
  gitSha: string;
  createdAt: string;
};

export type NewSnapshot = {
  projectId: string;
  key: string;
  gitSha: string;
};

export interface SnapshotStore {
  record(snapshot: NewSnapshot): Promise<SnapshotRecord>;

  /** The newest snapshot for a project, or null if it has never been torn down. */
  latestFor(projectId: string): Promise<SnapshotRecord | null>;

  /**
   * Every snapshot for a project, newest first.
   *
   * Deleting a project has to remove its objects as well as its rows, and the rows are the
   * only record of which keys those are — so this exists to make that cascade possible
   * rather than because anything wants to display a history.
   */
  listFor(projectId: string): Promise<SnapshotRecord[]>;
}
