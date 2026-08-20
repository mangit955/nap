/**
 * Which sessions have a turn running *in this process*, and how to stop one quickly.
 *
 * It used to be the whole of cancellation: a route started a turn, held its `AbortController` here
 * so a later request from another tab could find it, and cleared it when the turn settled. That is
 * no longer where a turn comes from — the queue is, and the worker that claimed a request owns the
 * controller for it. So this is now written to by the worker and read by three things: the cancel
 * route, the reaper, and the project routes' "is this busy?".
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
   * The queue's per-session lease means there should never be a second one — but a controller
   * dropped on the floor is a turn nothing can stop, and that is worse than a turn that ends early.
   */
  adopt(sessionId: string, controller: AbortController): void {
    this.#running.get(sessionId)?.abort();
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

  isRunning(sessionId: string): boolean {
    return this.#running.has(sessionId);
  }
}
