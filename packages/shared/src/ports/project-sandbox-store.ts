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
 * **Viewing is reported, not counted as activity.** A tab somebody is looking at writes no event,
 * so the store also says when a viewer last signalled — and leaves what that is worth to the sweep.
 * It cannot be folded into the activity above: that is the clock the sweep's hard cap is measured
 * from, and a viewer moving it would let one forgotten tab keep a sandbox alive forever.
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
  /**
   * When somebody last signalled they were looking at the project, or null if nobody has since
   * the column existed. Not activity — see the top of this file.
   */
  viewedAt: string | null;
};

/**
 * The most often a project's viewer signal is written, however many tabs on however many pods are
 * sending one. Well inside the idle limit, so throttling costs the sweep no precision it uses.
 */
export const VIEWER_SIGNAL_INTERVAL_MS = 60_000;

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
   *
   * **Compare-and-clear on `sandboxId`.** The caller read which machine to put away some seconds
   * earlier, and a turn may have recorded a fresh one since — after an owner abandoned the old
   * one, say. Clearing unconditionally would forget that fresh machine mid-turn, leaving it
   * running and named by nothing until the reconciler destroyed it. So nothing is written unless
   * the project still names `sandboxId`, and the answer says which happened: `false` means the
   * project has moved on and owes nobody an announcement about the machine just put away.
   */
  releaseSandbox(
    projectId: string,
    sandboxId: string,
    snapshotKey: string | null,
  ): Promise<boolean>;

  /**
   * Records that somebody is looking at the project `sessionId` belongs to, right now.
   *
   * Throttled here, to one write per `VIEWER_SIGNAL_INTERVAL_MS` per project, rather than by any
   * caller: the row is shared by every tab on every pod, so only the store can see them all. A
   * project holding no sandbox, or a session nobody knows, records nothing — there is nothing to
   * keep warm. **Authorizes nothing**: the caller must already have established the viewer may
   * read this session, which on `/ws` is the socket's own check.
   */
  recordViewer(sessionId: string): Promise<void>;
}
