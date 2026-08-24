/**
 * "May this process sweep?" — one holder at a time, across the cluster.
 *
 * The reaper is deployed as a single replica, and that is not by itself enough: a rolling update
 * runs the new pod while the old one is still shutting down, and two sweeps overlapping would
 * snapshot and destroy the same project twice — the second one against a sandbox that has already
 * gone, releasing a slot of the ceiling that was already given back.
 *
 * So the sweeps ask this first. It is *not* a lock over a project or a session: the busy check
 * stays a filter, deliberately (see `sweepIdleProjects`), and this guards the whole schedule
 * rather than anything inside a tick.
 *
 * **Asked every tick rather than acquired once at boot**, because a process that has lost its lock
 * — its connection dropped and Postgres released everything that session held — must find out. The
 * implementation is expected to be cheap enough to ask on every tick and to take the lock back if
 * it is free.
 */

export interface SweepLock {
  /**
   * Whether this process holds the lock now, taking it if it is free.
   *
   * False is an ordinary answer and not a failure: it means somebody else is sweeping, and the
   * right response is to do nothing until the next tick.
   */
  held(): Promise<boolean>;

  /**
   * Gives the lock up, so the next process can sweep without waiting for a connection to drop.
   *
   * Safe to call having never held it. A process that exits without calling this still releases
   * it — the database drops what a session holds when the session ends — but only once the
   * database notices the socket is gone, which is exactly the overlap a rollout would hit.
   */
  release(): Promise<void>;
}
