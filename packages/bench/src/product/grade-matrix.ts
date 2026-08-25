/**
 * Every grade a set of judgements carries, as one table a person can read in a terminal.
 *
 * **This exists because a paid run's verdicts are not its findings.** `checkDiscrimination` folds
 * nine judgements down to seven met-or-unmet lines, which is what a *test* needs and is strictly
 * less than what was bought: an arm that reports "the margin was 11, needed 15" says nothing about
 * *which* of the nine dimensions the judge separated the corpus's two ends on, and that is the
 * question anybody arguing about the expectation's shape has to answer. Four funded arms went by
 * before this was noticed, and none of them left the matrix behind — so the fifth had to be bought
 * to learn something the first four had already seen and thrown away. The suite that prints the
 * verdicts prints this too.
 *
 * **Letters rather than words, and a dot rather than a letter.** Nine dimensions of `moderate` do
 * not fit a line, and a column that wraps is a column nobody compares. The dot matters more: a
 * `not_assessable` dimension is absence rather than a low grade — `judgement.ts` and `product-
 * score.ts` both turn on that distinction — so a matrix that printed a letter for it would undo at
 * the point of reading what the scorer is careful about everywhere else.
 *
 * **The denominator is in the table.** A product score is a mean over *the dimensions that were
 * assessed*, so two fixtures' scores can be means over different sets, and a margin between them
 * is then not quite a like-for-like comparison. Printing `9/9` beside the number is the cheapest
 * possible guard: it does not stop the comparison, it makes the reader see it.
 *
 * Formatting only. It asserts nothing, so it belongs beside the scorer rather than inside the
 * check — a table that failed a run would be a second, weaker copy of `discrimination.ts`.
 */

import { PRODUCT_DIMENSIONS, type ProductDimension } from "./dimension.ts";
import type { Grade } from "./grade.ts";
import type { ProductJudgement } from "./judgement.ts";
import { scoreProduct } from "./product-score.ts";

/**
 * One character per grade.
 *
 * `satisfies` rather than an annotation, so a scale that gains a point fails to compile here
 * rather than printing a blank column. A test pins that the five are distinct, because two grades
 * sharing a letter is the one mistake that would make the table quietly unreadable rather than
 * obviously wrong.
 */
export const GRADE_LETTERS = {
  excellent: "E",
  good: "G",
  moderate: "M",
  weak: "W",
  poor: "P",
} as const satisfies Record<Grade, string>;

/** What a dimension that was looked at and could not be graded prints as. Not a grade. */
export const NOT_ASSESSABLE_MARK = "·";

/** Four characters is enough to tell the nine apart, and they are checked to be distinct. */
function abbreviate(dimension: ProductDimension): string {
  return dimension.slice(0, 4);
}

const GRADE_COLUMN_WIDTH = 5;

/**
 * Wide enough for the longest id it was actually given, *and a space* — which is not the same
 * thing, and the difference cost a row.
 *
 * A fixed 26 was the first version, chosen as the length of the longest corpus id. That is exactly
 * the length of `desktop-only-breaks-mobile`, so `padEnd` added nothing and the id ran straight
 * into its first grade: one row of nine came out unreadable in the very arm this was written to
 * record. Measured from the input rather than written down, so a longer id widens the table
 * instead of breaking it.
 */
function fixtureColumnWidth(ids: readonly string[]): number {
  return Math.max("fixture".length, ...ids.map((id) => id.length)) + 2;
}

/**
 * The table, header included, as a newline-joined string.
 *
 * A string rather than lines or rows, because every caller is about to `console.log` it and the
 * one that is not — a write-up being pasted into a document — wants the same thing. Fixtures come
 * out in the order the map holds them, which is the order they were judged in, so a reader
 * comparing a printed table with a run's own log is not reconciling two orderings.
 */
export function formatGradeMatrix(judgements: ReadonlyMap<string, ProductJudgement>): string {
  const width = fixtureColumnWidth([...judgements.keys()]);

  const header = [
    "fixture".padEnd(width),
    ...PRODUCT_DIMENSIONS.map((dimension) => abbreviate(dimension).padEnd(GRADE_COLUMN_WIDTH)),
    "score",
    " assessed",
  ].join("");

  const rows = [...judgements].map(([id, judgement]) => rowFor(id, judgement, width));

  return [header, ...rows].join("\n");
}

function rowFor(id: string, judgement: ProductJudgement, width: number): string {
  const name = id.padEnd(width);

  // A judge that did not run has no grades and no score, and a row of dots would say the wrong
  // thing about it — dots mean "looked at and could not grade", which is a different fact.
  if (judgement.status === "not_run") return `${name}no judge ran: ${judgement.reason}`;

  const cells = PRODUCT_DIMENSIONS.map((dimension) => {
    const answer = judgement.dimensions[dimension];
    const mark = answer.status === "graded" ? GRADE_LETTERS[answer.grade] : NOT_ASSESSABLE_MARK;
    return mark.padEnd(GRADE_COLUMN_WIDTH);
  });

  const score = scoreProduct(judgement);
  const number = score === undefined ? "  —  " : String(score.score).padStart(5);
  const assessed = score === undefined ? "" : ` ${score.assessed}/${PRODUCT_DIMENSIONS.length}`;

  return `${name}${cells.join("")}${number}${assessed}`;
}
