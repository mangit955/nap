/**
 * How many sandboxes may exist at once, and who is holding one — durable, and atomic.
 *
 * A sandbox is billed for every second it exists, so the ceiling on how many run at once is the
 * only thing bounding the total bill. Counting them and then creating one is a race: under
 * concurrent admissions every counter reads the same number and every caller decides it is
 * within the limit. This port closes that by making a *reservation* the thing that consumes
 * capacity, taken atomically before the provider is ever called.
 *
 * **Rows, not a counter.** A counter cannot be reconciled — a leaked increment and a creation
 * still in flight look identical, so nothing can ever safely decrement it. A row records which
 * project holds the capacity and since when, so a sweep can tell a reservation whose process
 * died from one that is three seconds old and about to be used.
 *
 * **Reserved before created, activated after.** The cap is enforced on the reservation, which
 * means it is never exceeded and is only ever temporarily under-used — the right direction for a
 * limit whose job is to cap a bill. `activate` records the sandbox the reservation became, so a
 * reservation is no longer waiting on anything; `release` gives the capacity back when creation
 * failed or when the sandbox is torn down.
 *
 * The limits themselves belong to whoever implements this, not to the caller: the point of
 * creation is inside the runtime, which has no business knowing a deployment's budget.
 */

import type { Result, VoidResult } from "../result.ts";

/** A reservation to hand back to `activate` or `release`. */
export type Reservation = { id: string };

export type CapacityRefusal = {
  reason: /** This user is already holding as many sandboxes as they may. */
    | "per_user"
    /** Everybody together is, across every process talking to this database. */
    | "total"
    /**
     * This project already holds a reservation — another turn is creating its sandbox, or has.
     *
     * Refused rather than joined: two callers each believing they own the creation is how a
     * project ends up with two sandboxes, one of which nothing references and nobody stops
     * paying for.
     */
    | "project_held";
  message: string;
};

/**
 * The one way activating can fail: the reservation is no longer there to activate.
 *
 * A reservation expires while it is still `reserved`, because a caller that dies between reserving
 * and creating must not hold a slot forever — so a creation slower than the TTL comes back to find
 * its row reclaimed. An answer rather than an exception, because by then the caller is holding a
 * real, running, billed sandbox that this deployment's ceiling is not counting, and it has to be
 * told so it can do something about it.
 */
export type ActivationFailure = {
  reason: "reservation_reclaimed";
  message: string;
};

export interface SandboxCapacity {
  /**
   * Claims capacity for a project's sandbox, atomically, before anything is created.
   *
   * Returns a refusal rather than throwing: being at a limit is an outcome the caller is
   * expected to report, not a bug.
   */
  reserve(request: {
    projectId: string;
    userId: string;
  }): Promise<Result<Reservation, CapacityRefusal>>;

  /**
   * Records that the reservation became this sandbox, so it is no longer waiting on a creation.
   *
   * Reports whether there was still a reservation to record it against. Silence on finding no row
   * would leave the caller believing a sandbox is counted when nothing counts it, which is a
   * sandbox running outside the ceiling that bounds this deployment's bill.
   */
  activate(reservationId: string, sandboxId: string): Promise<VoidResult<ActivationFailure>>;

  /** Gives back capacity a creation never used. */
  release(reservationId: string): Promise<void>;

  /**
   * Gives back whatever capacity a project holds, reserved or active.
   *
   * Keyed by project because a teardown knows which project it just put away and not which
   * reservation opened it — often a different process, hours earlier.
   */
  releaseForProject(projectId: string): Promise<void>;
}
