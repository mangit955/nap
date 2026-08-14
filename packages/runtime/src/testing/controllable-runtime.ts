/**
 * A `Runtime` whose turns finish when the test says so.
 *
 * The route under test answers *while* a turn is still running — it starts one, registers it for
 * cancellation, and replies — so a runtime that resolved immediately would make a route that
 * awaits the turn look identical to one that does not. Holding the turn open is the whole point.
 *
 * The other half is a turn that rejects, which is what makes a detached promise dangerous: nothing
 * is awaiting it, so an unhandled rejection takes the process down rather than the request.
 */

import type { ResumeOutcome, Runtime, TurnOutcome, TurnRequest } from "@nap/shared/ports/runtime";

export class ControllableRuntime implements Runtime {
  /** Every turn asked for, in order, so a test can read what the route passed down. */
  readonly requests: TurnRequest[] = [];

  #finish: ((outcome: TurnOutcome) => void) | undefined;
  #rejects = false;

  /** Makes the next turn reject rather than hang, for the detached-promise cases. */
  static throwing(): ControllableRuntime {
    const runtime = new ControllableRuntime();
    runtime.#rejects = true;
    return runtime;
  }

  runTurn(request: TurnRequest): Promise<TurnOutcome> {
    this.requests.push(request);
    if (this.#rejects) return Promise.reject(new Error("the runtime fell over"));

    return new Promise<TurnOutcome>((resolve) => {
      this.#finish = resolve;
    });
  }

  /** A resume takes a different route; a test that reaches this is testing the wrong thing. */
  async resumeSession(): Promise<ResumeOutcome> {
    throw new Error("not part of this test");
  }

  /** Ends the turn the way a completed one ends. */
  complete(outcome: Partial<TurnOutcome> = {}): void {
    this.#finish?.({ ok: true, turnId: "t1", commitSha: null, ...outcome } as TurnOutcome);
  }

  /** The signal the most recent turn was given, which is what cancellation is asserted on. */
  get signal(): AbortSignal | undefined {
    return this.requests.at(-1)?.signal;
  }
}
