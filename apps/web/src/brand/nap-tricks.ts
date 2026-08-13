/**
 * What the ghost does while you wait.
 *
 * A project coming back up takes tens of seconds — long enough that a spinner stops reading as
 * progress and starts reading as a page that has stopped. So the mark does something instead,
 * and the point of a *list* of things is that no two waits look the same: a loop of one gesture
 * is a spinner with extra steps, and the eye stops seeing it within two cycles.
 *
 * Kept as data, and separate from the component, because the interesting part is the choosing
 * — which needs no DOM to check, and is exactly where an off-by-one would leave the ghost
 * frozen on an undefined trick with nothing in the console to say why.
 *
 * Each trick names a CSS animation in `globals.css` and how long to let it run. The durations
 * are the animation's own: cutting one off mid-hop drops the ghost through the floor.
 */

export type Trick = {
  /** Written to `data-trick`, which is what the stylesheet selects on. */
  readonly name: string;
  /** How long to hold it before choosing another, in milliseconds. */
  readonly ms: number;
  /**
   * Relative likelihood. A spin every time reads as a busy indicator; a spin once in a while
   * reads as a character with a sense of humour.
   */
  readonly weight: number;
};

export const TRICKS: readonly Trick[] = [
  // Looking around is the quietest thing on the list and the one that most reads as *waiting*,
  // so it carries the most weight.
  { name: "glance", ms: 2400, weight: 4 },
  { name: "hop", ms: 1100, weight: 3 },
  { name: "wobble", ms: 1400, weight: 3 },
  { name: "peek", ms: 1600, weight: 2 },
  { name: "spin", ms: 1300, weight: 1 },
] as const;

/** The still beat between two tricks. Without it the ghost never stops moving, which is manic. */
export const REST_MS = 700;

/**
 * The next thing to do, given the last one.
 *
 * **Never the same trick twice running.** Repeating is what a weighted pick does naturally and
 * it is the one outcome that undoes the whole point of having five of them — two hops in a row
 * read as a two-second animation rather than as a ghost that hopped and then did something
 * else.
 *
 * `random` is passed in rather than taken from `Math.random`, so the choice is a pure function
 * of its inputs and every branch is reachable from a test.
 */
export function nextTrick(previous: Trick | undefined, random: number): Trick {
  const eligible = TRICKS.filter((trick) => trick.name !== previous?.name);
  const total = eligible.reduce((sum, trick) => sum + trick.weight, 0);

  // Clamped rather than trusted: `random` is a caller's number, and one that arrives at exactly
  // 1 — or above it — would walk off the end of the list and freeze the ghost on `undefined`.
  const target = Math.min(Math.max(random, 0), 0.999999) * total;

  let seen = 0;
  for (const trick of eligible) {
    seen += trick.weight;
    if (target < seen) return trick;
  }

  // Unreachable while the list has weight, and a real value beats a throw: the ghost is
  // decoration, and nothing about a loading state is worth taking a pane down for.
  return eligible[0] ?? TRICKS[0] ?? { name: "glance", ms: 2400, weight: 1 };
}
