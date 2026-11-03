/**
 * Which requests are running *in this process*, and how to stop one quickly.
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
 * acts on within one renewal interval, or at once if the cancel wake-up reaches it. This spares that
 * wait only for a composition running every role in one process, meaning scripts and tests, which
 * pass no channel. In a deployed process it finds nothing: an API pod runs no turns and a worker pod
 * serves no route. No entrypoint can run the roles together (`docs/adr/0023`, D6).
 *
 * **Keyed by request, because that is what was flagged.** A session key would abort whatever is
 * running on that session by the time this is called, which can be a turn admitted after the cancel
 * that nobody asked to stop.
 */

import { TurnAbortError } from "@nap/shared/turn-abort";
export class TurnRegistry {
  readonly #running = new Map<string, AbortController>();

  /**
   * Records that this process is running a request, and how to stop it.
   *
   * A request is claimed at most once, so nothing can already be here (`docs/scaling-design.md`
   * §5, §6) and there is nothing to abort.
   */
  adopt(requestId: string, controller: AbortController): void {
    this.#running.set(requestId, controller);
  }

  /** Whether the abort reached a turn. `false` means it is running elsewhere, or had ended. */
  cancel(requestId: string): boolean {
    const controller = this.#running.get(requestId);
    if (controller === undefined) return false;

    controller.abort(new TurnAbortError("cancelled"));
    this.#running.delete(requestId);
    return true;
  }

  /** Called when a turn settles, whichever way it settled. */
  release(requestId: string, controller: AbortController): void {
    if (this.#running.get(requestId) !== controller) return;
    this.#running.delete(requestId);
  }
}
