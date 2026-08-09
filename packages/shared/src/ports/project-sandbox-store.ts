/**
 * Which projects are holding a sandbox, and how to let one go.
 *
 * A sandbox is billed for as long as it exists, and most of them spend most of their life
 * with nobody looking at them. Something has to sweep those up — snapshot the project, destroy
 * the sandbox, and write down that the project no longer has one. That sweep needs two
 * questions answered that no other part of the system asks, which is what this port is.
 *
 * **Idleness is measured from the event log, not from a column somebody has to remember to
 * update.** Every turn writes events by construction, so "the newest event in any of this
 * project's sessions" cannot drift from what actually happened, while a `last_active_at`
 * column is a second source of truth that goes stale the first time a code path forgets it.
 *
 * Deliberately not part of `SessionStore`, and deliberately not project CRUD. It is the slice
 * a reaper needs and nothing more — a wider interface would mean every caller holding a fake
 * had to implement creating, renaming and archiving to test a sweep.
 */

export type IdleProject = {
  projectId: string;
  /** The sandbox to snapshot and destroy. Projects without one are never candidates. */
  sandboxId: string;
  /**
   * Every session in the project, so a caller can ask whether any of them has a turn running.
   * Turns are tracked per session; sandboxes belong to the project those sessions share.
   */
  sessionIds: string[];
  lastActiveAt: string;
};

export interface ProjectSandboxStore {
  /** Projects holding a sandbox whose most recent activity is older than `cutoff`. */
  idleSince(cutoff: string): Promise<IdleProject[]>;

  /**
   * Records that the project's sandbox is gone and its bytes are at `snapshotKey`.
   *
   * Clearing the sandbox is the point. Left recorded, the next turn tries to resume something
   * that no longer exists, and the recovery path treats that as a project whose work may have
   * been lost — when in fact the snapshot is exactly current. Cleared, the next turn simply
   * restores it.
   *
   * `null` means the sandbox went away without being snapshotted — a provider reclaimed it
   * before anything could — so the reference is dropped while whatever snapshot the project
   * already had is left in place. Overwriting it with nothing would throw away the last
   * copy of the project that still exists.
   */
  releaseSandbox(projectId: string, snapshotKey: string | null): Promise<void>;
}
