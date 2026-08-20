/**
 * What `NAP_WORKER_CONCURRENCY` should start at, derived rather than guessed.
 *
 * `docs/scaling-design.md` §24 item 1 says plainly that 5 is a guess and that the baseline run
 * is what sets it. This is the arithmetic that turns a measurement into that number, and it is
 * Little's law and nothing cleverer: the work in flight at any moment is how fast it arrives
 * multiplied by how long each piece takes. A turn is minutes of waiting on a sandbox and a
 * model rather than seconds of CPU, so the ceiling that matters is how many a worker may have
 * *open*, not how many it can compute.
 *
 * Headroom is separate from the law and deliberately so: a queue served at exactly its arrival
 * rate has unbounded wait, which is the one property nobody wants from a number chosen for a
 * production deployment.
 */

export type ConcurrencyInput = {
  /** Turns accepted per second, at the load the deployment is being sized for. */
  turnsPerSecond: number;
  /** How long one turn holds a worker, end to end. */
  meanTurnMs: number;
  /** How many worker replicas will share the load. */
  workers: number;
  /** Multiplier over the steady-state figure. Defaults to 1.5 — half as much again. */
  headroom?: number;
};

export type ConcurrencyAdvice = {
  /** Turns in flight across the whole deployment at steady state, by Little's law. */
  inFlight: number;
  /** What one worker should be allowed to hold, headroom included. Never below 1. */
  perWorker: number;
  headroom: number;
};

export function recommendWorkerConcurrency(input: ConcurrencyInput): ConcurrencyAdvice {
  const headroom = input.headroom ?? 1.5;

  if (input.turnsPerSecond < 0 || input.meanTurnMs < 0) {
    throw new RangeError("a negative arrival rate or turn duration is not a measurement");
  }
  if (!Number.isInteger(input.workers) || input.workers < 1) {
    throw new RangeError("the work has to be shared across at least one worker");
  }

  const inFlight = input.turnsPerSecond * (input.meanTurnMs / 1_000);

  return {
    inFlight,
    // Rounded up and floored at one: a deployment that may hold no turns at all serves nobody,
    // and the fractional answer to "how many may this pod hold" is not a setting.
    perWorker: Math.max(1, Math.ceil((inFlight * headroom) / input.workers)),
    headroom,
  };
}
