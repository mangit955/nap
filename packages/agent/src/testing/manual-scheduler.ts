import type { Schedule } from "../delta-stream.ts";

/**
 * Timers that run only when a test moves time on.
 *
 * `DeltaStream` takes its scheduler as an argument so that "nothing buffered waits longer than
 * the window" can be proven without waiting the window out, and without `vi.useFakeTimers`
 * reaching into every other timer in the process. `pending` is the point of having a fake of
 * our own: a test about a finished or abandoned stream should assert that no timer is *left*,
 * not merely that none has fired yet — a leaked timer looks exactly like a correct one until
 * it goes off.
 */
export class ManualScheduler {
  #time = 0;
  #nextId = 0;
  readonly #timers = new Map<number, { at: number; run: () => void }>();

  /** Shaped like `Schedule`, and bound, so it can be handed over as `scheduler.schedule`. */
  readonly schedule: Schedule = (run, ms) => {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#time + ms, run });
    return () => {
      this.#timers.delete(id);
    };
  };

  /** How many timers are armed and not yet run or cancelled. */
  get pending(): number {
    return this.#timers.size;
  }

  get now(): number {
    return this.#time;
  }

  /**
   * Moves time forward, running every timer that falls due on the way in the order it falls
   * due — including any a running timer arms, if that one is due within the same advance.
   */
  advance(ms: number): void {
    const until = this.#time + ms;
    for (;;) {
      let next: [number, { at: number; run: () => void }] | undefined;
      for (const entry of this.#timers) {
        if (entry[1].at <= until && (next === undefined || entry[1].at < next[1].at)) next = entry;
      }
      if (next === undefined) break;
      this.#timers.delete(next[0]);
      this.#time = next[1].at;
      next[1].run();
    }
    this.#time = until;
  }
}
