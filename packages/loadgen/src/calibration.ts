/**
 * How slow the fakes pretend to be, and where those numbers came from.
 *
 * A load test on instant fakes measures nothing: every turn finishes before the next user has
 * connected, so no two are ever concurrent and the thing under test — a hundred turns in flight
 * at once — never happens. The fakes therefore have to take about as long as the real thing,
 * and the only defensible source for "about as long" is a run that really happened.
 *
 * Every figure below is from `docs/napbench-first-real-run.md` (the "Preview reachability held"
 * and "Turns are fast and cheap" findings), which recorded eight funded benchmark runs against
 * real E2B and a real model:
 *
 *   - a sandbox served its preview on the first probe, **3,074ms from cold**;
 *   - the page rendered through the public proxy **2.4s after navigation**;
 *   - turn time ran **8–43 seconds**.
 *
 * Nothing here is invented, and nothing here should be adjusted to make a run finish sooner.
 * If these need to change, they change because another funded run recorded something different.
 */

export type Range = { min: number; max: number };

export const CALIBRATION = {
  /** Cold start: `create` until the sandbox is usable. */
  sandboxCreateMs: 3_074,
  /** How long after the address exists before it actually serves a page. */
  previewRenderMs: 2_400,
  /**
   * One turn end to end — the model's share of it, which is what a fake provider stands in for.
   * A range rather than a figure because the recorded spread is more than fivefold, and a load
   * generator where every user takes exactly the same time produces a synchronised herd that no
   * real deployment ever sees.
   */
  turnMs: { min: 8_000, max: 43_000 } satisfies Range,
} as const;

/**
 * A pseudo-random stream that is the same every time for one seed.
 *
 * `Math.random` would make each run's latencies different, which is precisely the wrong
 * property for something whose output is compared against a previous run's — the whole point of
 * a baseline is that a change in the numbers came from a change in the system. Mulberry32:
 * small, fast, and adequate for spreading think time about.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A draw from `range`, uniform over it. */
export function sampleRange(range: Range, random: () => number): number {
  return range.min + (range.max - range.min) * random();
}
