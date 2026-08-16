/**
 * A set of scores, described — because one run is an anecdote.
 *
 * Two runs of the same task, under the same model and the same configuration, scored 88 and 74.
 * Nothing in the tool said so, which meant a single run per model could be read as a difference
 * between models when it was a difference between afternoons. This is what makes that visible:
 * the spread is reported beside the average, so a gap smaller than the noise is recognisable as
 * one.
 *
 * **Per task, never across tasks.** A standard deviation over a whole suite measures how much
 * the *tasks* differ in difficulty, which is a fact about the benchmark rather than about the
 * model — and quoting it as run-to-run variance would be exactly the sort of plausible,
 * unfounded number this benchmark exists not to produce.
 *
 * Pure arithmetic over an array, so every case here — one score, none, all identical — is
 * settled by a test rather than by whatever the CLI happened to be handed.
 */

/**
 * What a set of scores came to, with every figure null when it cannot honestly be given.
 *
 * `stdDev` is the one that matters: it is null for a single run rather than zero, because zero
 * is a claim of perfect consistency and what actually happened is that nobody measured twice.
 * Reporting an unmeasured figure as a measured one is the failure mode of the whole tool.
 */
export type Distribution = {
  /** How many scores this is over. Zero is possible: a task whose every run errored. */
  n: number;
  /** To one decimal place, like every other figure a reader compares by eye. */
  mean: number | null;
  /** The middle, or the midpoint of the two middle scores when there is no single middle. */
  median: number | null;
  /**
   * Sample standard deviation, over `n - 1`.
   *
   * Sample rather than population because these runs *are* a sample: the question being asked
   * is how much this configuration varies in general, not how much these particular three runs
   * varied among themselves. It also makes the single-run case divide by zero, which is the
   * right answer arriving by the right route — one run says nothing about spread.
   */
  stdDev: number | null;
  /** The extremes, which are what a reader actually wants when the spread turns out to be wide. */
  lowest: number | null;
  highest: number | null;
};

const NOTHING: Distribution = {
  n: 0,
  mean: null,
  median: null,
  stdDev: null,
  lowest: null,
  highest: null,
};

export function describeDistribution(scores: readonly number[]): Distribution {
  if (scores.length === 0) return { ...NOTHING };

  // Copied before sorting: the caller's array is a suite's runs in the order they finished, and
  // quietly reordering somebody else's list is a bug that surfaces somewhere else entirely.
  const sorted = [...scores].sort((a, b) => a - b);
  const mean = sorted.reduce((total, score) => total + score, 0) / sorted.length;

  return {
    n: sorted.length,
    mean: round1(mean),
    median: round1(medianOf(sorted)),
    stdDev: sorted.length < 2 ? null : round1(sampleStdDev(sorted, mean)),
    lowest: sorted[0] ?? null,
    highest: sorted[sorted.length - 1] ?? null,
  };
}

/**
 * The middle score, averaging the two middle ones when the count is even.
 *
 * Written over a `slice` rather than by indexing, so there is no `?? 0` to fabricate. Zero is a
 * perfectly plausible score, and a module whose entire argument is that an unmeasured figure
 * must never be reported as a measured one should not have one sitting in it waiting for a
 * guard to move.
 */
function medianOf(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  const middles =
    sorted.length % 2 === 1
      ? sorted.slice(middle, middle + 1)
      : sorted.slice(middle - 1, middle + 1);

  return middles.reduce((total, score) => total + score, 0) / middles.length;
}

function sampleStdDev(scores: readonly number[], mean: number): number {
  const squaredError = scores.reduce((total, score) => total + (score - mean) ** 2, 0);

  return Math.sqrt(squaredError / (scores.length - 1));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
