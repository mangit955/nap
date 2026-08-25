import { describe, expect, it } from "vitest";
import { PRODUCT_DIMENSIONS, type ProductDimension } from "./dimension.ts";
import { GRADES, type Grade } from "./grade.ts";
import { formatGradeMatrix, GRADE_LETTERS, NOT_ASSESSABLE_MARK } from "./grade-matrix.ts";
import { type DimensionJudgement, PRODUCT_NOT_RUN, type ProductJudgement } from "./judgement.ts";

function graded(grade: Grade): DimensionJudgement {
  return {
    status: "graded",
    grade,
    evidence: [
      {
        surfaceId: "home",
        viewport: "desktop",
        screenshot: "minimalist-professional/desktop.png",
        observation: "a white background and one accent",
      },
    ],
    strengths: [],
    weaknesses: [],
  };
}

const UNASSESSABLE: DimensionJudgement = {
  status: "not_assessable",
  reason: "the surface never rendered",
};

/** Every dimension at one grade, then whichever of them the caller wanted answered differently. */
function judged(
  grade: Grade,
  overrides: Partial<Record<ProductDimension, DimensionJudgement>> = {},
): ProductJudgement {
  return {
    status: "judged",
    judge: { source: "test", rubricVersion: "test" },
    dimensions: Object.fromEntries(
      PRODUCT_DIMENSIONS.map((dimension) => [dimension, overrides[dimension] ?? graded(grade)]),
    ) as Record<ProductDimension, DimensionJudgement>,
    polish: graded(grade),
  };
}

describe("GRADE_LETTERS", () => {
  it("gives every grade a distinct single character", () => {
    const letters = GRADES.map((grade) => GRADE_LETTERS[grade]);

    expect(new Set(letters).size).toBe(GRADES.length);
    for (const letter of letters) expect(letter).toHaveLength(1);
  });
});

describe("formatGradeMatrix", () => {
  it("gives every dimension a column heading nothing else shares", () => {
    const [header] = formatGradeMatrix(
      new Map([["minimalist-professional", judged("good")]]),
    ).split("\n");
    const headings = (header ?? "")
      .trim()
      .split(/\s+/)
      .slice(1, 1 + PRODUCT_DIMENSIONS.length);

    // The abbreviation is a prefix, so a tenth dimension beginning `respo…` would collide with
    // `responsiveness` and the table would have two columns nobody could tell apart.
    expect(new Set(headings).size).toBe(PRODUCT_DIMENSIONS.length);
  });

  it("heads the table with every dimension and the product score", () => {
    const [header] = formatGradeMatrix(
      new Map([["minimalist-professional", judged("good")]]),
    ).split("\n");

    // Abbreviated, because nine full dimension names do not fit a terminal line — but every one
    // of the nine has to be there, or a reader cannot tell which column they are looking at.
    expect(header).toMatch(/hier.+typo.+spac.+colo.+layo.+comp.+inte.+resp.+rest/);
    expect(header).toContain("score");
  });

  it("puts one letter per graded dimension beside the fixture's product score", () => {
    const rows = formatGradeMatrix(new Map([["minimalist-professional", judged("good")]])).split(
      "\n",
    );
    const row = rows.find((line) => line.startsWith("minimalist-professional"));

    // Nine `good` anchors mean a mean of exactly the `good` anchor, which is what makes this
    // assertable at all: the row's number has to be the product score and not a count.
    expect(row).toContain("78");
    expect(row?.match(/\bG\b/g)).toHaveLength(9);
  });

  it("reads the fixtures in the order they were given", () => {
    const table = formatGradeMatrix(
      new Map([
        ["ai-slop-generic", judged("weak")],
        ["minimalist-professional", judged("good")],
      ]),
    );

    expect(table.indexOf("ai-slop-generic")).toBeLessThan(table.indexOf("minimalist-professional"));
  });

  it("tells an ungraded dimension apart from a bad grade", () => {
    const table = formatGradeMatrix(
      new Map([["minimalist-professional", judged("good", { responsiveness: UNASSESSABLE })]]),
    );

    // The whole point of the corpus's `not_assessable` handling is that absence is not a low
    // score. A matrix that printed a letter here would undo that at the only place a person
    // actually reads the grades.
    expect(table).toContain(NOT_ASSESSABLE_MARK);
    expect(table.match(/\bG\b/g)).toHaveLength(8);
  });

  it("counts how many dimensions a score was a mean over", () => {
    const table = formatGradeMatrix(
      new Map([["minimalist-professional", judged("good", { responsiveness: UNASSESSABLE })]]),
    );

    // A margin between two means over different numbers of dimensions is not a like-for-like
    // comparison, and this is where a reader sees that it happened.
    expect(table).toContain("8/9");
  });

  /**
   * A fixed-width name column was the first version, set to the length of the longest corpus id —
   * which meant `padEnd` added nothing to that one id and it ran into its own first grade. The
   * table was printed by a funded arm before anybody noticed.
   */
  it("keeps a space between the longest fixture id and its first grade", () => {
    const ids = ["ai-slop-generic", "desktop-only-breaks-mobile"];
    const rows = formatGradeMatrix(new Map(ids.map((id) => [id, judged("good")]))).split("\n");

    // Each id followed by a space, rather than a regex over the whole row: a row that has *any*
    // gap in it later on satisfies "id then whitespace", which is how the first version of this
    // test passed against the very bug it was written for.
    for (const [index, id] of ids.entries()) {
      expect(rows[index + 1]?.startsWith(`${id} `)).toBe(true);
    }
  });

  it("says a judge did not run rather than drawing an empty row of grades", () => {
    const table = formatGradeMatrix(new Map([["ai-slop-generic", PRODUCT_NOT_RUN]]));

    expect(table).toContain("no judge ran");
    expect(table).not.toContain("·");
  });
});
