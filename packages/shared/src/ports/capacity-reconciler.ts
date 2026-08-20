/**
 * Putting back the sandbox capacity nothing gave back on its own.
 *
 * A reservation is claimed before the provider is called and released when the sandbox it names
 * is destroyed, which covers every path that runs to the end. The paths that do not are what
 * this port is for: a process that dies between reserving and creating leaves a `reserved` row
 * nobody will ever release, and a sandbox the provider reclaims on its own timer leaves an
 * `active` row naming something that has stopped existing. Both hold a slot of the ceiling that
 * bounds this deployment's bill, and neither heals without a sweep.
 *
 * **Deliberately separate from `SandboxCapacity`.** That port is the admission path — reserve,
 * activate, release, one project at a time and on the critical path of every turn. This one is
 * read by a sweep, is about no project in particular, and has to read *other* tables to do its
 * job: which sandbox a project still names is not a fact the reservations table holds. Keeping
 * them apart means the fake every caller of the admission path holds does not have to model a
 * projects table to answer a question it never asks.
 */

/** What one reconciliation pass gave back, as reservation ids, so a sweep can report it. */
export type ReclaimedCapacity = {
  /**
   * `reserved` rows past their expiry: something claimed a slot and never created anything.
   *
   * The count climbing steadily means processes are dying mid-creation, which is worth a look
   * — capacity comes back either way, but a few minutes late every time.
   */
  expired: string[];
  /**
   * `active` rows whose sandbox no project names any more: it was destroyed out of band.
   *
   * Almost always the provider's own timer, which answers to nothing in this system.
   */
  orphaned: string[];
};

export interface CapacityReconciler {
  /**
   * Deletes both kinds of stranded row, and says which they were.
   *
   * One call rather than two because they are one pass over one table and a caller has no
   * reason to want only half of it.
   */
  reclaimStranded(): Promise<ReclaimedCapacity>;

  /**
   * Every sandbox id anything in the database still points at, from any project or session.
   *
   * The question behind it is the inverse: a sandbox at the provider that appears in *no*
   * answer here is one nothing can ever find again, and is being billed for. Read separately
   * from `reclaimStranded` because it is the more dangerous of the two — a caller acting on a
   * partial answer would destroy a live project's sandbox — so it either answers fully or
   * fails, and a failure must stop the pass rather than shrink the set.
   */
  referencedSandboxIds(): Promise<string[]>;

  /**
   * Which of these project ids this database has ever heard of.
   *
   * Asked because "the provider is running a sandbox no row references" is not on its own
   * evidence of a leak: `bun run harness --real` and a funded NapBench run both create sandboxes
   * on the same E2B account, tagged with project ids belonging to a throwaway database or to no
   * database at all. A deployment that destroyed everything it could not account for would kill
   * those mid-run. A sandbox whose project this database does not know is somebody else's
   * business; one whose project it *does* know, and does not name, is a leak.
   */
  knownProjectIds(projectIds: string[]): Promise<string[]>;
}
