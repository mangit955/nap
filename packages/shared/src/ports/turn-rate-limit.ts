/**
 * How often one person may start a turn — durable, and shared by every process.
 *
 * Every turn is a real model call and a real sandbox billed by the second, so an unbounded
 * endpoint is an unbounded bill, reachable by a loop in a browser tab as easily as by malice.
 * A limiter that lived in a process would give each replica its own allowance, so the ceiling
 * that makes an open demo door affordable would silently multiply by the replica count.
 *
 * **A sliding window, not a fixed one.** A fixed window is simpler and wrong twice: someone can
 * spend a full allowance either side of a boundary, taking double the limit in a moment, and it
 * cannot answer the question `Retry-After` asks. Keeping the individual times means the answer is
 * exact — the oldest one leaving the window is precisely when a slot opens.
 *
 * **A refused attempt costs nothing.** Recording it would push a retrying client's recovery
 * further away with every attempt, so the time it was told to wait would never arrive.
 *
 * **The clock belongs to the implementation, which is why `check` takes no `now`.** For anything
 * shared, the only clock every process agrees on is the store's own; a caller passing its idea of
 * the time would make the allowance depend on whose machine was fast. A fake takes its clock as a
 * constructor argument instead, so tests stay arithmetic rather than waiting.
 *
 * **One limiter is one allowance.** Two allowances — free turns and paid ones — are two instances
 * of this, never one shared between them, or somebody's paid turns would eat their free allowance
 * and "5 free turns an hour" would mean something different depending on what else they did.
 */

export type RateDecision =
  | { allowed: true }
  /** Whole seconds, and never zero — `Retry-After: 0` invites an immediate, futile retry. */
  | { allowed: false; retryAfterSeconds: number };

export interface TurnRateLimiter {
  /**
   * Whether this user may start a turn now, recording it if so.
   *
   * Returns a decision rather than throwing: being at a limit is an outcome the caller is
   * expected to report, not a bug.
   */
  check(userId: string): Promise<RateDecision>;

  /**
   * Forgets everything that has left the window, and says how much that was.
   *
   * Separate from `check` because it is a different job on a different schedule: admission is on
   * the critical path of every turn and concerns one user, while this concerns no user in
   * particular and exists so that somebody who sends one message and never returns does not
   * leave a record behind forever. Run by the reaper, which is where the deployment's other
   * "come past occasionally and put things right" work already lives.
   */
  sweep(): Promise<number>;
}
