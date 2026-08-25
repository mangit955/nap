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

import type { ScreenshotRef } from "../screenshot.ts";
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

/**
 * The judge's share of a run's screenshots: the ones somebody asked for, and none of the rest.
 *
 * A check's photograph is deliberately excluded even though it is a picture of the same
 * application. It was taken at whatever size that check finished at, of whatever the check had
 * driven the page into, and labelled with the assertion rather than the view — so it cannot be
 * paired with anything, and `responsiveness` is graded on pairs. Including them would also put
 * the cost up on every real run for images nobody can cite as evidence about a surface.
 */
export function surfaceScreenshotsOf(screenshots: readonly ScreenshotRef[]): SurfaceScreenshot[] {
  const surfaces: SurfaceScreenshot[] = [];

  for (const shot of screenshots) {
    if (shot.surface === null) continue;
    surfaces.push({
      surfaceId: shot.surface.id,
      // The size the pass *asked for*, not the one measured: it is what pairs two images, and a
      // page that resized itself comes back with no measured name at all. See `screenshot.ts`.
      viewport: shot.surface.viewport,
      path: shot.path,
    });
  }

  return surfaces;
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
 *
 * **Not the same thing as `scriptedProductJudge` in `testing/scripted-judgement.ts`**, and the
 * difference is what each is for. This answers with a judgement decided entirely in advance,
 * whatever it is shown — which is what a fixture wants, since the fixture *is* the answer. That
 * one builds its judgement from the screenshots it was handed, which is what the free path wants,
 * since a report whose evidence cites images the run never took would not be exercising the thing
 * a paid run will do.
 */
export function scriptedProductEvaluation(judgement: ProductJudgement): ProductEvaluation {
  return { evaluate: async () => judgement };
}
