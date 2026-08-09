/**
 * Which sessions have a turn running, and how to stop one.
 *
 * Cancellation crosses two requests: a turn is started by one and abandoned by another,
 * possibly from a different tab, so the `AbortController` has to outlive the handler that
 * made it. This is the only place in the API that holds state between requests, which is why
 * it is a class with six lines of logic rather than a `Map` in a module.
 *
 * **Finishing takes the signal it is finishing.** A turn that ends after the next one has
 * begun would otherwise clear the new turn's entry and silently disable its cancel button —
 * the entry is only removed if it is still the one that was registered.
 *
 * Per process, deliberately. A second API instance would not find the controller, and the
 * honest fix for that is a cancellation signal in the database rather than a shared map;
 * v1 runs one instance, and the failure mode is a cancel that does nothing rather than a
 * cancel that stops someone else's turn.
 */

export class TurnRegistry {
  readonly #running = new Map<string, AbortController>();

  /** Registers a turn and returns the signal to hand to `runTurn`. */
  start(sessionId: string): AbortSignal {
    // The runtime queues turns per session, so this should not happen — but a controller
    // dropped on the floor is a turn nothing can stop, and that is worse than a turn that
    // ends early.
    this.#running.get(sessionId)?.abort();

    const controller = new AbortController();
    this.#running.set(sessionId, controller);
    return controller.signal;
  }

  /** Whether the abort reached a turn. `false` means it had already ended. */
  cancel(sessionId: string): boolean {
    const controller = this.#running.get(sessionId);
    if (controller === undefined) return false;

    controller.abort();
    this.#running.delete(sessionId);
    return true;
  }

  /** Called when a turn settles, whichever way it settled. */
  finish(sessionId: string, signal?: AbortSignal): void {
    const controller = this.#running.get(sessionId);
    if (controller === undefined) return;
    if (signal !== undefined && controller.signal !== signal) return;

    this.#running.delete(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.#running.has(sessionId);
  }
}
