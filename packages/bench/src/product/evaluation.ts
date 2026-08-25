/**
 * The port a judge implements, and the two implementations that need no judge at all.
 *
 * A port for the reason `BrowserSession` is one: `docs/adr/0001` keeps this package pure, so
 * anything that reaches a network lives in `apps/napbench` and arrives here as an interface.
 * The consequence worth stating is that **the scorer never learns how a judgement was made** —
 * it is handed a `ProductJudgement` and folds it. A scripted judge in a unit test and a vision
 * model on a paid run therefore drive the identical scoring path, so the free tests are testing
 * the thing that will actually run rather than a rehearsal of it.
 *
 * **The judge is not shown the prompt, and that is deliberate.** What is being asked is the
 * question a person opening the finished application would ask, and they have no specification
 * in front of them. Handing over the task's prompts would also blur the two halves: the judge
 * would start grading whether the feature list was implemented, which the objective half already
 * measures with commands and browser checks and measures better, because a check cannot be
 * talked round. What the judge gets instead is one neutral sentence of `intent` — enough to know
 * whether this is a ledger or a landing page, since information density means different things
 * for each — and nothing that says how it should have been built.
 */

import type { ViewportName } from "../viewport.ts";
import { PRODUCT_NOT_RUN, type ProductJudgement } from "./judgement.ts";

/**
 * One image the judge will look at, labelled with what it is a picture of.
 *
 * Named by surface and viewport rather than by the check that happened to leave it behind,
 * because `responsiveness` is graded by comparing one surface across two sizes, and that
 * comparison is only possible if the pairing is stated. Screenshots taken as a by-product of
 * browser checks cannot supply this — a check is named for what it asserts, not for what it is
 * looking at — which is why surfaces are declared separately by the task.
 */
export type SurfaceScreenshot = {
  /** As the task named it: `empty`, `populated`, `detail`. */
  surfaceId: string;
  viewport: ViewportName;
  /** Relative to the results directory, like every other path in a report. */
  path: string;
};

export type ProductEvaluationInput = {
  taskId: string;
  runId: string;
  /**
   * One neutral sentence about what the application is for. See this file's header for why it
   * is this and not the prompts.
   */
  intent: string;
  /**
   * References rather than bytes: the images are already on disk by the time this is asked, a
   * suite's worth of PNGs held in memory for a judge that returns `not_run` would be paid for by
   * every free run, and an adapter that wants the pixels can read the path it was handed.
   */
  screenshots: readonly SurfaceScreenshot[];
};

export interface ProductEvaluation {
  evaluate(input: ProductEvaluationInput): Promise<ProductJudgement>;
}

/** The default: there is no judge, and saying so is the honest result. */
export function notRunProductEvaluation(): ProductEvaluation {
  return { evaluate: async () => PRODUCT_NOT_RUN };
}

/**
 * A judgement decided in advance — the free path's judge, and every unit test's.
 *
 * It exists so that the product half is exercised end to end on a run that costs nothing:
 * without it, every free run would score objective-only and the geometric combination, the
 * renormalisation and the report's product section would all be untested until somebody paid.
 * Its grades mean nothing about any application, which is the same caveat a dry run already
 * carries about its score.
 */
export function scriptedProductEvaluation(judgement: ProductJudgement): ProductEvaluation {
  return { evaluate: async () => judgement };
}
