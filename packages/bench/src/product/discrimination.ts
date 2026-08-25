/**
 * What the corpus's grades must *do*, and the check that says whether they did it.
 *
 * **Orderings and bounds, never absolute numbers.** `restraint` on `excessive-gradient` is at most
 * `weak`; `minimalist-professional` beats `ai-slop-generic` by a real margin. What is never
 * asserted is that a fixture scores 62, because that is this repo's "never assert on model prose"
 * rule wearing different clothes: an exact grade is the judge's phrasing, and a run that came back
 * one anchor lower on two dimensions would fail a test while having discriminated perfectly well.
 * An ordering is the claim actually being made — *can this instrument tell these two apart* — and
 * it survives a judge being retuned, reworded or replaced.
 *
 * **Absence is not failure, and this is the subtle one.** A judge that answered `not_assessable`,
 * a fixture nobody photographed and a run where the judge was never composed all produce no grade
 * to compare. Scoring those as failures would make the check fail loudest exactly when it has
 * learned nothing, and — worse — a green run would then be evidence that could equally mean "the
 * judge discriminated" or "half the corpus was skipped". They are reported as a third status, so a
 * reader can tell "the instrument was wrong" from "the instrument was not asked".
 *
 * **The expectations are data, and the check is a fold.** Free unit tests run it against a judge
 * that knows the answer key, and against one that grades everything identically — which must fail
 * every expectation, because that is the failure mode this whole corpus exists to catch. The paid
 * suite in `apps/napbench` runs the identical function against a real judge over real screenshots.
 * Two paths, one set of claims.
 */

import type { CorpusFixtureId } from "./corpus.ts";
import type { ProductDimension } from "./dimension.ts";
import { GRADES, type Grade } from "./grade.ts";
import type { ProductJudgement } from "./judgement.ts";
import { scoreProduct } from "./product-score.ts";

/**
 * How far apart two product scores have to be before the gap is a finding.
 *
 * Fifteen points, from the arithmetic of the scale rather than from taste. The product half is a
 * mean over nine dimensions and the anchors are seventeen to twenty-three points apart, so one
 * dimension differing by a whole grade moves the mean by about two points — well inside the noise
 * of a judge that saw one screenshot differently. Fifteen is reached only when most of the nine
 * disagree, which is what "these are different products" actually looks like, and it is still
 * comfortably below the gap between a fixture built to be good and one built to be slop.
 */
export const MEANINGFUL_MARGIN = 15;

/**
 * One claim about the corpus's grades.
 *
 * A discriminated union rather than a bound with optional ends, so there is no representable
 * expectation that constrains a grade from neither side — which would pass against anything and
 * read, in a list, exactly like an expectation that meant something.
 */
export type DiscriminationExpectation =
  | {
      kind: "beats";
      better: CorpusFixtureId;
      worse: CorpusFixtureId;
      /** In points of product score. See `MEANINGFUL_MARGIN`. */
      byAtLeast: number;
      because: string;
    }
  | {
      kind: "grade_at_most";
      fixture: CorpusFixtureId;
      dimension: ProductDimension;
      /** The best grade this fixture may receive. `weak` admits `weak` and `poor`. */
      grade: Grade;
      because: string;
    }
  | {
      kind: "grade_at_least";
      fixture: CorpusFixtureId;
      dimension: ProductDimension;
      /** The worst grade this fixture may receive. `good` admits `good` and `excellent`. */
      grade: Grade;
      because: string;
    };

/**
 * The claims the corpus is built to support.
 *
 * Each one is a *pair*, and the pairing is what makes it a test of discrimination rather than of
 * severity. A judge that marks every icon down passes the `excessive-icon` bound on its own; it
 * fails once `icons-restrained` has to come back `good` as well. The same holds for the two
 * responsive fixtures and for the two ends of the quality range.
 */
export const CORPUS_EXPECTATIONS: readonly DiscriminationExpectation[] = [
  {
    kind: "beats",
    better: "minimalist-professional",
    worse: "ai-slop-generic",
    byAtLeast: MEANINGFUL_MARGIN,
    because:
      "the two ends of the corpus. A judge that cannot separate a considered interface from the generated house style is measuring nothing, whatever it says about the seven in between",
  },
  {
    kind: "beats",
    better: "broken-beautiful",
    worse: "correct-ugly",
    byAtLeast: MEANINGFUL_MARGIN,
    because:
      "the judge sees screenshots and no source, so on the product half alone the polished-but-hollow one must win. Its being hollow is the objective half's finding, and a product half that hedged towards correctness would be doing the objective half's job badly",
  },
  {
    kind: "grade_at_most",
    fixture: "excessive-gradient",
    dimension: "restraint",
    grade: "weak",
    because:
      "a gradient on every surface is decoration applied because it was available, which is the question `restraint` asks. Slop is not a penalty list — one gradient can be the right call — so the fixture overdoes it until the answer is not in doubt",
  },
  {
    kind: "grade_at_most",
    fixture: "excessive-icon",
    dimension: "restraint",
    grade: "weak",
    because:
      "there is no icon dimension, deliberately, so icon overuse has nowhere else to land. If this comes back `moderate` the rubric is not carrying the decision the rubric was written to carry",
  },
  {
    kind: "grade_at_least",
    fixture: "icons-restrained",
    dimension: "restraint",
    grade: "good",
    because:
      "the other half of the icon pair. A judge that has learned `icons are bad` rather than `decoration must earn its place` marks this down too, and would otherwise pass the bound above while having understood nothing",
  },
  {
    kind: "grade_at_most",
    fixture: "desktop-only-breaks-mobile",
    dimension: "responsiveness",
    grade: "weak",
    because:
      "the mobile capture is visibly the desktop layout clipped. This is the dimension deliberately measured twice — the objective half asserts no horizontal overflow, and this asks whether the small viewport was designed for",
  },
  {
    kind: "grade_at_least",
    fixture: "responsive-strong",
    dimension: "responsiveness",
    grade: "good",
    because:
      "the other half of the responsive pair, and the one that catches a judge which grades every mobile screenshot down for being narrow",
  },
];

/** Whether a grade is no better than a ceiling. `at most weak` admits `weak` and `poor`. */
export function isAtMost(grade: Grade, ceiling: Grade): boolean {
  return GRADES.indexOf(grade) >= GRADES.indexOf(ceiling);
}

/** Whether a grade is no worse than a floor. `at least good` admits `good` and `excellent`. */
export function isAtLeast(grade: Grade, floor: Grade): boolean {
  return GRADES.indexOf(grade) <= GRADES.indexOf(floor);
}

export type DiscriminationStatus =
  /** The grades did what the corpus says they must. */
  | "met"
  /** They were compared, and they did not. This is the instrument being wrong. */
  | "unmet"
  /**
   * There was nothing to compare — the judge did not run, could not assess the dimension, or the
   * fixture was never judged. See this file's header: not a failure, and not a pass either.
   */
  | "not_assessable";

export type DiscriminationOutcome = {
  expectation: DiscriminationExpectation;
  status: DiscriminationStatus;
  /** What was actually observed, so a failing run reads as evidence rather than as a boolean. */
  detail: string;
};

/**
 * One line naming what an expectation claims, without its reasoning.
 *
 * Separate from `because` so a summary can list seven claims and a reader can then go and read
 * the one that failed. Both are prose, but only this one is short enough to put in a table.
 */
export function describeExpectation(expectation: DiscriminationExpectation): string {
  if (expectation.kind === "beats") {
    return `${expectation.better} beats ${expectation.worse} by at least ${expectation.byAtLeast} points`;
  }

  const bound = expectation.kind === "grade_at_most" ? "at most" : "at least";
  return `${expectation.fixture} ${expectation.dimension} ${bound} ${expectation.grade}`;
}

/**
 * Whether a set of judgements told the corpus apart.
 *
 * Takes judgements by fixture id rather than a judge, because the two callers acquire them
 * differently — a unit test scripts them, and the paid suite buys them one vision call at a time —
 * and neither difference is anything this should know about.
 */
export function checkDiscrimination(
  judgements: ReadonlyMap<string, ProductJudgement>,
  expectations: readonly DiscriminationExpectation[] = CORPUS_EXPECTATIONS,
): DiscriminationOutcome[] {
  return expectations.map((expectation) => ({
    expectation,
    ...(expectation.kind === "beats"
      ? checkMargin(expectation, judgements)
      : checkBound(expectation, judgements)),
  }));
}

/**
 * The expectations that were compared and disagreed — and only those.
 *
 * What a test asserts is empty. An unassessable expectation is deliberately not in here: it
 * belongs in whatever the caller prints, because a run that could assess nothing should be read
 * rather than failed, and reporting it as a failure would put the loudest signal on the case with
 * the least information in it.
 */
export function unmetExpectations(
  outcomes: readonly DiscriminationOutcome[],
): DiscriminationOutcome[] {
  return outcomes.filter((outcome) => outcome.status === "unmet");
}

/** A one-line summary of a whole check, for a script or a test failure message. */
export function summariseDiscrimination(outcomes: readonly DiscriminationOutcome[]): string {
  const counted = (status: DiscriminationStatus) =>
    outcomes.filter((outcome) => outcome.status === status).length;

  return `${counted("met")} met, ${counted("unmet")} unmet, ${counted("not_assessable")} not assessable, of ${outcomes.length}`;
}

type Verdict = Pick<DiscriminationOutcome, "status" | "detail">;

function checkMargin(
  expectation: Extract<DiscriminationExpectation, { kind: "beats" }>,
  judgements: ReadonlyMap<string, ProductJudgement>,
): Verdict {
  const better = productScoreOf(expectation.better, judgements);
  const worse = productScoreOf(expectation.worse, judgements);

  if (better === undefined || worse === undefined) {
    const missing = [
      better === undefined ? expectation.better : undefined,
      worse === undefined ? expectation.worse : undefined,
    ].filter((id) => id !== undefined);

    return {
      status: "not_assessable",
      detail: `no product score for ${missing.join(" and ")}`,
    };
  }

  const margin = better - worse;

  return {
    status: margin >= expectation.byAtLeast ? "met" : "unmet",
    detail: `${expectation.better} scored ${better} and ${expectation.worse} scored ${worse}, a margin of ${margin}`,
  };
}

function checkBound(
  expectation: Extract<DiscriminationExpectation, { kind: "grade_at_most" | "grade_at_least" }>,
  judgements: ReadonlyMap<string, ProductJudgement>,
): Verdict {
  const judgement = judgements.get(expectation.fixture);

  if (judgement === undefined) {
    return { status: "not_assessable", detail: `nothing judged ${expectation.fixture}` };
  }
  if (judgement.status === "not_run") {
    return {
      status: "not_assessable",
      detail: `no judge ran on ${expectation.fixture}: ${judgement.reason}`,
    };
  }

  const answer = judgement.dimensions[expectation.dimension];
  if (answer.status !== "graded") {
    return {
      status: "not_assessable",
      detail: `${expectation.dimension} was not assessable on ${expectation.fixture}: ${answer.reason}`,
    };
  }

  const held =
    expectation.kind === "grade_at_most"
      ? isAtMost(answer.grade, expectation.grade)
      : isAtLeast(answer.grade, expectation.grade);

  return {
    status: held ? "met" : "unmet",
    detail: `${expectation.fixture} ${expectation.dimension} was graded ${answer.grade}`,
  };
}

/**
 * A fixture's product half, or nothing.
 *
 * Nothing covers all three absences at once — never judged, judge did not run, and judged with no
 * assessable dimension — because `scoreProduct` already collapses the last two, and a margin has
 * the same amount to say about each of them.
 */
function productScoreOf(
  id: CorpusFixtureId,
  judgements: ReadonlyMap<string, ProductJudgement>,
): number | undefined {
  const judgement = judgements.get(id);
  if (judgement === undefined) return undefined;

  return scoreProduct(judgement)?.score;
}
