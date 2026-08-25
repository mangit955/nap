/**
 * Where a real product judge is composed — and, today, the honest statement that there isn't one.
 *
 * `@nap/bench` defines `ProductEvaluation` as a port precisely so that whatever grades screenshots
 * lives out here, in the app, beside the browser adapter and behind the same `--real` flag. This
 * is that end of the seam. It is currently one function returning a reason rather than a judge,
 * and that is deliberate rather than unfinished: nothing in this repository has yet verified that
 * a vision model accepts image input through the OpenRouter path we use — `LLMContentBlock` has no
 * image variant — and a resolver that returned a plausible-looking judge which could not actually
 * see anything would produce a full report of grades about nothing.
 *
 * **Why the seam exists before the judge does.** The fixture corpus is the check on the judge, and
 * a check written after the thing it checks tends to be written to pass. The paid discrimination
 * suite is therefore written now, against this function, and skips while there is nothing to
 * compose; the day a vision adapter lands, it is this function that changes and the suite runs
 * unmodified. What it asserts was decided without knowing what the model would say.
 *
 * **Nothing here may reuse the agent's `LLMProvider`.** That is the thing under test. A judge that
 * shared a provider with the agent would share its retries, its fallbacks and its accounting, and
 * a benchmark whose grader and subject fail together measures neither.
 */

import type { ProductEvaluation } from "@nap/bench/product/evaluation";
import type { Result } from "@nap/shared/result";

export type ProductJudgeOptions = {
  /**
   * The directory the screenshot paths in a `ProductEvaluationInput` are relative to.
   *
   * Required rather than inferred, because the two callers root them differently: a real run
   * against its results directory, and the corpus suite against the committed fixtures. The port
   * deliberately carries relative paths only — see `product/evaluation.ts` — so somebody has to
   * say what they are relative to, and it is the composer rather than the evaluator.
   */
  screenshotRoot: string;
};

/**
 * A judge, or the reason there is none.
 *
 * A `Result` rather than `undefined`, because "no judge is configured" is an ordinary outcome that
 * every caller has to say something about — a run reports `not_run` with this reason attached, and
 * the corpus suite prints it and skips. An absent value would let a caller shrug, and a product
 * half that quietly vanished is the one failure mode `docs/adr/0002`-style renormalisation makes
 * invisible in the number.
 */
export function resolveProductJudge(
  _env: NodeJS.ProcessEnv,
  _options: ProductJudgeOptions,
): Result<ProductEvaluation, string> {
  return {
    ok: false,
    error:
      "no vision judge is composed: sending an image through the provider path this repo uses has not been verified, and a judge that cannot see would grade nothing convincingly",
  };
}
