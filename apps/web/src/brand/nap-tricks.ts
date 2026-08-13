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

/**
 * The beat between two tricks.
 *
 * Short, because it is no longer a *still* beat: the ghost floats, sways, breathes and blinks
 * underneath whatever it is doing, so this is the pause between two deliberate gestures rather
 * than a pause in the animation. When it was seven hundred milliseconds of nothing moving, the
 * whole thing read as a picture being transformed on a timer.
 */
export const REST_MS = 350;

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
  return pickDifferent(TRICKS, previous, random, (trick) => trick.weight);
}

/**
 * One of `options`, weighted, and never the one just used.
 *
 * Shared because the loader picks two things this way — what the ghost does, and the word under
 * it — and a second copy of the never-repeat rule is a second place for it to stop being true.
 *
 * The equality that decides "the same one" is identity: callers hand back the item they were
 * given last time, so nothing here needs to know what an item *is*.
 */
export function pickDifferent<T>(
  options: readonly T[],
  previous: T | undefined,
  random: number,
  weightOf: (option: T) => number = () => 1,
): T {
  const eligible = options.filter((option) => option !== previous);
  const total = eligible.reduce((sum, option) => sum + weightOf(option), 0);

  // Clamped rather than trusted: `random` is a caller's number, and one that arrives at exactly
  // 1 — or above it — would walk off the end of the list and freeze the ghost on `undefined`.
  const target = Math.min(Math.max(random, 0), 0.999999) * total;

  let seen = 0;
  for (const option of eligible) {
    seen += weightOf(option);
    if (target < seen) return option;
  }

  // Unreachable while the list has weight, and a real value beats a throw: this is decoration,
  // and nothing about a loading state is worth taking a pane down for.
  const fallback = eligible[0] ?? options[0];
  if (fallback === undefined) throw new Error("pickDifferent needs something to pick from");
  return fallback;
}
