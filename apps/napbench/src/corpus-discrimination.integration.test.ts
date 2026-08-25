/**
 * Watches a real judge tell the fixture corpus apart — the one thing no dry run can prove.
 *
 * Everything free about the product half exercises the *machinery*: the schema refuses an
 * unevidenced grade, the fold renormalises an absent dimension, the two halves multiply. None of
 * that says whether the instrument works, because the scripted judge's grades were decided in
 * advance. An evaluator nobody has watched discriminate is a check that has never been observed
 * failing, and this file is where it is observed.
 *
 * **It asserts orderings and bounds, never absolute numbers.** `icons-restrained` out-grades
 * `excessive-icon` on `restraint`; `minimalist-professional` beats `ai-slop-generic`. Asserting
 * that a fixture scores 62 would be this repo's "never assert on model prose" rule broken in
 * numeric form — an exact anchor is the judge's phrasing, and a run one grade lower on two
 * dimensions would fail while having discriminated perfectly well. The claims live in
 * `@nap/bench`'s `CORPUS_EXPECTATIONS` so that the free suite and this one make the identical
 * ones.
 *
 * **What it costs.** Nine fixtures at two images each: eighteen images through a vision model in
 * one pass of the corpus, and nothing else. No sandbox, no agent, no E2B — the applications are
 * static files photographed once and committed. That is the cheapest possible way to buy an answer
 * to "does the judge work", and it is deliberately separable from a benchmark run, which costs
 * orders of magnitude more and cannot answer this question at all: a real run has no fixture whose
 * quality is known in advance.
 *
 * Needs: whatever `resolveProductJudge` needs — today an `OPENROUTER_API_KEY`, and nothing else.
 * No Chrome, no sandbox, no credentials beyond that. It skips, loudly, when there is no judge.
 */

import {
  CORPUS_FIXTURES,
  CORPUS_INTENT,
  corpusSurfaceScreenshots,
} from "@nap/bench/product/corpus";
import {
  checkDiscrimination,
  type DiscriminationStatus,
  describeExpectation,
  summariseDiscrimination,
  unmetExpectations,
} from "@nap/bench/product/discrimination";
import type { ProductJudgement } from "@nap/bench/product/judgement";
import { beforeAll, describe, expect, it } from "vitest";
import { CORPUS_ROOT, missingCorpusArtefacts } from "./corpus-fixtures.ts";
import { resolveProductJudge } from "./product-judge.ts";

const judge = resolveProductJudge(process.env, { screenshotRoot: CORPUS_ROOT });

if (!judge.ok) {
  console.warn(`skipping the corpus discrimination suite: ${judge.error}`);
}

/** So a scan down the output finds the disagreements without reading every line. */
const MARKS: Record<DiscriminationStatus, string> = {
  met: "\u2713",
  unmet: "\u2717",
  not_assessable: "?",
};

/** One run id for the whole pass, so every judgement is attributable to this one sitting. */
const RUN_ID = `corpus-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;

describe.skipIf(!judge.ok)("the fixture corpus, judged for real", () => {
  const judgements = new Map<string, ProductJudgement>();

  // Nine judgements, serially, at roughly half a minute each on a reasoning model — comfortably
  // past the project's 120s hook timeout, which was set for a cold sandbox rather than for this.
  beforeAll(async () => {
    // Restated for the compiler, which `describe.skipIf` cannot narrow through.
    if (!judge.ok) throw new Error("unreachable: guarded by describe.skipIf");

    // Before spending anything: a corpus missing an image would come back `not_assessable` on
    // whichever expectation names it, which reads as "we learned nothing" after paying for the
    // other seventeen images.
    expect(missingCorpusArtefacts()).toEqual([]);

    // Serially, and one fixture per call. Each fixture is an independent judgement of one
    // application — a judge shown all nine at once would be ranking them against each other,
    // which is a different and much easier question than the one a real run asks.
    for (const fixture of CORPUS_FIXTURES) {
      judgements.set(
        fixture.id,
        await judge.value.evaluate({
          taskId: fixture.id,
          runId: RUN_ID,
          intent: CORPUS_INTENT,
          screenshots: corpusSurfaceScreenshots(fixture.id),
        }),
      );
    }
  }, 900_000);

  it("meets every ordering and bound the corpus is built to test", () => {
    const outcomes = checkDiscrimination(judgements);
    const unmet = unmetExpectations(outcomes).map(
      (outcome) => `${describeExpectation(outcome.expectation)} — ${outcome.detail}`,
    );

    // Every outcome, whether or not anything failed. Two reasons, and the second is the one that
    // earns the noise: a run where most expectations were unassessable is green and worthless, and
    // the counts are the only place that shows; and this run cost real money, so what it observed
    // — the grades, not just the verdicts — is the artefact, and a suite that printed a pass/fail
    // would make somebody pay again to find out what the judge actually said.
    for (const outcome of outcomes) {
      console.log(
        `  ${MARKS[outcome.status]} ${describeExpectation(outcome.expectation)} — ${outcome.detail}`,
      );
    }
    console.log(summariseDiscrimination(outcomes));

    expect(unmet).toEqual([]);
  });

  /**
   * A judge that answered `not_assessable` everywhere would satisfy the assertion above while
   * having graded nothing. Absence is not a failure — see `discrimination.ts` — so this is where
   * an absent-everything run is caught, separately and by name.
   */
  it("actually graded most of what it was shown", () => {
    const outcomes = checkDiscrimination(judgements);
    const assessed = outcomes.filter((outcome) => outcome.status !== "not_assessable");

    expect(assessed.length).toBeGreaterThan(outcomes.length / 2);
  });

  /** Every grade the corpus is scored on must cite an image, or the report is an opinion. */
  it("cited the corpus's own screenshots as evidence", () => {
    const paths = new Set(
      CORPUS_FIXTURES.flatMap((fixture) =>
        corpusSurfaceScreenshots(fixture.id).map((shot) => shot.path),
      ),
    );

    for (const [id, judgement] of judgements) {
      if (judgement.status !== "judged") continue;

      for (const answer of Object.values(judgement.dimensions)) {
        if (answer.status !== "graded") continue;
        for (const evidence of answer.evidence) {
          expect(paths, `${id} cited an image the corpus does not hold`).toContain(
            evidence.screenshot,
          );
        }
      }
    }
  });
});
