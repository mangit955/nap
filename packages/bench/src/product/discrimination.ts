/**
 * What the corpus's grades must *do*, and the check that says whether they did it.
 *
 * **Orderings and bounds, never absolute numbers.** `icons-restrained` grades better than
 * `excessive-icon` on `restraint`; `broken-beautiful` beats `correct-ugly` by a real margin. What
 * is never asserted is that a fixture scores 62, because that is this repo's "never
 * assert on model prose" rule wearing different clothes: an exact grade is the judge's phrasing,
 * and a run that came back one anchor lower on two dimensions would fail a test while having
 * discriminated perfectly well. An ordering is the claim actually being made — *can this
 * instrument tell these two apart* — and it survives a judge being retuned, reworded or replaced.
 *
 * **The two `restraint` claims were absolute bounds, and measurement moved them.** They asked for
 * `at most weak` on the two overuse fixtures, and three funded arms — two models, two rubric
 * revisions — put both at `moderate` and would not go lower. The pairs held throughout: the judge
 * graded `icons-restrained` above `excessive-icon` on every arm, so it *could* tell them apart and
 * simply disagreed with us about where on the scale the bad one sits. A `grade_at_most` is an
 * absolute claim about a single grade, which is the shape the paragraph above argues against, and
 * it was the wrong instrument for the claim the corpus was actually making. They are orderings
 * now. See `docs/napbench-vision-judge.md` for the numbers.
 *
 * **A whole-score margin only asks a fair question of fixtures built to differ everywhere.** The
 * corpus's two ends used to be compared that way, and a funded arm that recorded the grade matrix
 * rather than only the verdicts showed why it could not work: `minimalist-professional` and
 * `ai-slop-generic` were graded *identically* on six of the nine dimensions and two anchors apart
 * on two more. That is not a judge failing to discriminate — it is the fixture. Read what
 * `corpus.ts` says `ai-slop-generic` was built as: a hero gradient, emoji headings, identical
 * centred cards, and the tasks pushed below the fold by the marketing. Those are failings of
 * `hierarchy`, `layout` and `restraint`, and of nothing else. Its typography, colour, spacing and
 * components are competent *on purpose*, because competent execution of the wrong decisions is
 * what the generated house style actually is. A mean over nine dimensions then divides three real
 * two-anchor separations by nine and reports the dilution as a small margin. The three claims are
 * now named dimension by dimension, the same move the `restraint` bounds made.
 *
 * Be precise about how much that last step is worth. The *prose* predates every funded arm; the
 * *reading* of it into three dimension names came after the matrix, and it is a reading rather
 * than a derivation — "a purple hero gradient" could as honestly have been filed under `color`,
 * and "emoji headings" under `typography`. What the argument rests on is not the reading, and not
 * a number coming back lower than a threshold: it is that the two fixtures were built to be alike
 * on most of the scale, so the mean was never the thing to compare them with. See
 * `docs/napbench-corpus-margin.md`.
 *
 * **The other margin stayed a margin, and that is what makes the distinction a finding rather than
 * a rule.** `broken-beautiful` against `correct-ugly` was graded differently on *nine* of nine and
 * came in at 54 points. Those two are not a design pair — they differ in everything a photograph
 * shows — so the mean is measuring the thing it was derived for. A margin is not wrong for being a
 * margin; it is wrong when the pair it compares was built to differ in three places.
 *
 * **The responsive bounds stayed absolute, and that is the point of not doing this by rule.** They
 * are the same shape and they were met on every arm — a judge that grades the clipped mobile
 * capture `weak` is one whose scale agrees with ours *there*. An absolute bound is not wrong
 * because it is absolute; it is wrong when the corpus cannot demonstrate it, and only measurement
 * says which.
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
 * disagree, which is what "these are different products" actually looks like.
 *
 * **Unchanged, and now applied only where its own derivation holds.** The number survived a
 * proposal to lower it to ten, and the reason is in what it assumes rather than in what any run
 * measured: "most of the nine disagree" is a premise about the *pair*, not about the judge. It is
 * true of `correct-ugly` against `broken-beautiful`, which a funded arm graded differently on nine
 * of nine and 54 points apart. It was never true of the corpus's two ends, which differ by design
 * on three dimensions and were graded identically on six — so the margin there was diluting a real
 * separation rather than measuring a small one, and lowering the threshold would have been fitting
 * the constant to a pair the constant does not describe. Those three are asserted dimension by
 * dimension now. See this file's header and `docs/napbench-corpus-margin.md`.
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
      /**
       * One fixture out-grades another on one dimension — the pair form of a bound.
       *
       * Strictly better, by at least one anchor, and no magnitude: a *number* of anchors would be
       * an absolute claim wearing an ordering's clothes, and the whole reason this kind exists is
       * that the corpus can demonstrate the direction and not the distance. What it asks is the
       * only question the corpus was ever built to answer — can this instrument tell these two
       * apart — and it survives a judge whose scale sits higher or lower than ours.
       */
      kind: "grades_better";
      better: CorpusFixtureId;
      worse: CorpusFixtureId;
      dimension: ProductDimension;
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
    kind: "grades_better",
    better: "minimalist-professional",
    worse: "ai-slop-generic",
    dimension: "hierarchy",
    because:
      "the first of the three dimensions the corpus's two ends actually differ on, and the one `ai-slop-generic` was built around: its tasks are pushed below the fold by the marketing, so what reads first is not what the application is for. `corpus.ts` calls that out as the failing rather than as an artefact of photographing a viewport, which is what makes this a pre-registered claim and not a dimension chosen after seeing the grades",
  },
  {
    kind: "grades_better",
    better: "minimalist-professional",
    worse: "ai-slop-generic",
    dimension: "layout",
    because:
      "three identical centred cards and everything centred is a page arranged from a template rather than for its content, which is the question `layout` asks. Named in the fixture's own description alongside the other two",
  },
  {
    kind: "grades_better",
    better: "minimalist-professional",
    worse: "ai-slop-generic",
    dimension: "restraint",
    because:
      "a purple hero gradient and emoji headings, applied because they were available. The third and last of the differences the fixture was built with — and the reason the two ends are three `grades_better` claims rather than one margin: a mean over nine dimensions divides three real separations by nine, and reports a fixture that is competent on the other six as barely worse",
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
    kind: "grades_better",
    better: "minimalist-professional",
    worse: "excessive-gradient",
    dimension: "restraint",
    because:
      "a gradient on every surface is decoration applied because it was available, which is the question `restraint` asks. Slop is not a penalty list — one gradient can be the right call — so what is asserted is that the restrained fixture out-grades the one that overdoes it, rather than where either lands. The looser of the three pairs, and knowingly so: unlike the icon and responsive pairs these two do not share markup, so a judge could satisfy it by grading the general difference. It is still the strongest claim the corpus can support here, because `excessive-gradient` was written without a partner",
  },
  {
    kind: "grades_better",
    better: "icons-restrained",
    worse: "excessive-icon",
    dimension: "restraint",
    because:
      "there is no icon dimension, deliberately, so icon overuse has nowhere else to land. The pair is the claim: same structure, same stylesheet, same words, and the glyphs taken out — so a judge that grades them equally has not seen the only thing that differs. Asserted as an ordering because three funded arms put the overused one at `moderate` and would not go lower, while grading this one above it every time",
  },
  {
    kind: "grade_at_least",
    fixture: "icons-restrained",
    dimension: "restraint",
    grade: "good",
    because:
      "the ordering above holds even for a judge that has learned `icons are bad` and marks the whole pair down, so this is what stops the pair from sliding: the restrained half is a good use of icons and must be graded as one. Kept absolute rather than re-shaped because every arm met it — a bound is wrong when the corpus cannot demonstrate it, not because it is a bound",
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

/**
 * Every fixture an expectation makes a claim about.
 *
 * Exported so that nothing has to re-derive it by switching on `kind` — which is three places to
 * remember the day a fourth kind arrives, and the sort of enumeration that silently stops covering
 * the new one rather than failing.
 */
export function fixturesNamedBy(expectation: DiscriminationExpectation): CorpusFixtureId[] {
  return expectation.kind === "beats" || expectation.kind === "grades_better"
    ? [expectation.better, expectation.worse]
    : [expectation.fixture];
}

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
 * Separate from `because` so a summary can list every claim and a reader can then go and read
 * the one that failed. Both are prose, but only this one is short enough to put in a table.
 */
export function describeExpectation(expectation: DiscriminationExpectation): string {
  if (expectation.kind === "beats") {
    return `${expectation.better} beats ${expectation.worse} by at least ${expectation.byAtLeast} points`;
  }
  if (expectation.kind === "grades_better") {
    return `${expectation.better} grades better than ${expectation.worse} on ${expectation.dimension}`;
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
    ...verdictFor(expectation, judgements),
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

/** One switch over the kinds, so a kind added without a check fails to compile rather than to run. */
function verdictFor(
  expectation: DiscriminationExpectation,
  judgements: ReadonlyMap<string, ProductJudgement>,
): Verdict {
  switch (expectation.kind) {
    case "beats":
      return checkMargin(expectation, judgements);
    case "grades_better":
      return checkGradePair(expectation, judgements);
    default:
      return checkBound(expectation, judgements);
  }
}

/**
 * Whether one fixture out-graded another on one dimension.
 *
 * Both sides have to have been graded, and an ungraded side is `not_assessable` rather than a
 * failure — the same rule the bounds follow, and for the same reason: a comparison against
 * nothing has learned nothing, and reporting that as the instrument being wrong puts the loudest
 * signal on the case with the least information in it.
 */
function checkGradePair(
  expectation: Extract<DiscriminationExpectation, { kind: "grades_better" }>,
  judgements: ReadonlyMap<string, ProductJudgement>,
): Verdict {
  const better = gradeOf(expectation.better, expectation.dimension, judgements);
  const worse = gradeOf(expectation.worse, expectation.dimension, judgements);

  if (better.grade === undefined || worse.grade === undefined) {
    return {
      status: "not_assessable",
      detail: [better, worse]
        .filter((side) => side.grade === undefined)
        .map((side) => side.detail)
        .join("; "),
    };
  }

  // Strictly better: equal grades mean the judge did not tell them apart, which is the failure
  // this pair exists to catch and not a near miss to be forgiven.
  const held = GRADES.indexOf(better.grade) < GRADES.indexOf(worse.grade);

  return {
    status: held ? "met" : "unmet",
    detail:
      `${expectation.better} was graded ${better.grade} and ${expectation.worse} ` +
      `${worse.grade} on ${expectation.dimension}`,
  };
}

/**
 * One fixture's grade on one dimension, or why there is none.
 *
 * The reason travels with the absence because the three ways to have no grade — nobody judged the
 * fixture, no judge ran, the dimension was not assessable — are different facts about a run, and a
 * reader of a `not_assessable` outcome is trying to work out which one happened.
 */
function gradeOf(
  id: CorpusFixtureId,
  dimension: ProductDimension,
  judgements: ReadonlyMap<string, ProductJudgement>,
): { grade?: Grade; detail: string } {
  const judgement = judgements.get(id);
  if (judgement === undefined) return { detail: `nothing judged ${id}` };
  if (judgement.status === "not_run") {
    return { detail: `no judge ran on ${id}: ${judgement.reason}` };
  }

  const answer = judgement.dimensions[dimension];
  if (answer.status !== "graded") {
    return { detail: `${dimension} was not assessable on ${id}: ${answer.reason}` };
  }

  return { grade: answer.grade, detail: `${id} ${dimension} was graded ${answer.grade}` };
}

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
