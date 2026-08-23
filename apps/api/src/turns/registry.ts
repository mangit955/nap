/**
 * Which sessions have a turn running *in this process*, and how to stop one quickly.
 *
 * It used to be the whole of cancellation: a route started a turn, held its `AbortController` here
 * so a later request from another tab could find it, and cleared it when the turn settled. That is
 * no longer where a turn comes from — the queue is, and the worker that claimed a request owns the
 * controller for it. So this is now written to by the worker and read by exactly one thing: the
 * cancel route. It used to answer "is this session busy?" for the project routes and the reaper as
 * well, and that was wrong the moment turns moved to another process — the cluster-wide answer is
 * `TurnQueue.anyLeased`.
 *
 * **It is a fast path, not the mechanism.** The durable answer to "stop this turn" is
 * `cancel_requested` on the turn request, which any pod can set and the worker holding the lease
 * acts on within one renewal interval. This makes a cancel arriving at the pod that happens to be
 * running the turn instant instead, and does nothing at all when it arrives anywhere else. Both are
 * correct; one is nicer.
 *
 * **Releasing takes the controller it is releasing.** A turn that ends after the next one has begun
 * would otherwise clear the new turn's entry and silently disable its cancel button — the entry is
 * only removed if it is still the one that was adopted.
 */

export class TurnRegistry {
  readonly #running = new Map<string, AbortController>();

  /**
   * Records that this process is running a turn on this session, and how to stop it.
   *
   * **It does not abort whatever was here before, and there is nothing to abort.** It used to,
   * defensively. This map is keyed by session, and two live entries for one session would need two
   * turns running on it at once — which `turn_requests_one_leased_per_session` makes impossible,
   * since a worker only adopts a controller for a request it holds the session's lease on, and the
   * fencing window means the previous holder aborted before anyone else could claim
   * (`docs/scaling-design.md` §5, §17 B-5). A guard nobody can trigger is worse than no guard: it
   * has never been observed working, so it is not known to work, and it tells the next reader that
   * a race exists which the schema has already made impossible.
   */
  adopt(sessionId: string, controller: AbortController): void {
    this.#running.set(sessionId, controller);
  }

  /** Whether the abort reached a turn. `false` means it is running elsewhere, or had ended. */
  cancel(sessionId: string): boolean {
    const controller = this.#running.get(sessionId);
    if (controller === undefined) return false;

    controller.abort();
    this.#running.delete(sessionId);
    return true;
  }

  /** Called when a turn settles, whichever way it settled. */
  release(sessionId: string, controller: AbortController): void {
    if (this.#running.get(sessionId) !== controller) return;
    this.#running.delete(sessionId);
  }
}
