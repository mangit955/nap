/**
 * Where the real product judge is composed, and the one thing that decides whether there is one.
 *
 * `@nap/bench` defines `ProductEvaluation` as a port precisely so that whatever grades screenshots
 * lives out here, in the app, beside the browser adapter and behind the same `--real` flag. This
 * is that end of the seam: a credential, a model id, and the adapter in `vision-judge.ts`.
 *
 * **The model was verified before it was named here.** OpenRouter's registry says
 * `openai/gpt-5.6-luna` takes image input, which is a claim about the model; what a benchmark run
 * depends on is that the *Anthropic-shaped* `/v1/messages` endpoint forwards an image block to a
 * non-Anthropic model and answers with the `tool_use` block the judgement is carried in. Those are
 * different facts, and `scripts/vision-reachability.ts` bought the second one for a fraction of a
 * cent before this file named anything. Re-run it before naming a different model.
 *
 * **Nothing here may reuse the agent's `LLMProvider`.** That is the thing under test. A judge that
 * shared a provider with the agent would share its retries, its fallbacks and its accounting, and
 * a benchmark whose grader and subject fail together measures neither.
 */

import type { ProductEvaluation } from "@nap/bench/product/evaluation";
import type { Result } from "@nap/shared/result";
import { OpenRouterVisionJudge } from "./vision-judge.ts";

/**
 * The judge, unless something says otherwise.
 *
 * The same model the rest of the repository runs on, and that is a coincidence worth being awake
 * to rather than a design: the judge and the agent being the same model is a conflict of interest
 * on any task where the agent's taste and the judge's could agree for reasons other than the
 * screenshots. It is chosen here for cost — a corpus pass is pennies — and the day a funded run
 * is used to compare two models, the judge must be pinned to something neither of them is.
 * `NAP_JUDGE_MODEL` is how that is done without editing code.
 */
export const DEFAULT_JUDGE_MODEL = "openai/gpt-5.6-luna";

/** Overrides the model, for the reason above. Verified before use, not after. */
export const JUDGE_MODEL_ENV = "NAP_JUDGE_MODEL";

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

/** Which model would grade, given this environment. Read by the banner as well as by the judge. */
export function judgeModelOf(env: NodeJS.ProcessEnv): string {
  const named = env[JUDGE_MODEL_ENV];
  return named === undefined || named === "" ? DEFAULT_JUDGE_MODEL : named;
}

/**
 * A judge, or the reason there is none.
 *
 * A `Result` rather than `undefined`, because "no judge is configured" is an ordinary outcome that
 * every caller has to say something about — a real run refuses to start, and the corpus suite
 * prints it and skips. An absent value would let a caller shrug, and a product half that quietly
 * vanished is the one failure mode `docs/adr/0002`-style renormalisation makes invisible in the
 * number.
 */
export function resolveProductJudge(
  env: NodeJS.ProcessEnv,
  options: ProductJudgeOptions,
): Result<ProductEvaluation, string> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    return {
      ok: false,
      error:
        "OPENROUTER_API_KEY is not set, and the product judge is a vision model reached through " +
        "OpenRouter. Add it to apps/api/.env, or export it, then retry.",
    };
  }

  return {
    ok: true,
    value: new OpenRouterVisionJudge({
      apiKey,
      model: judgeModelOf(env),
      screenshotRoot: options.screenshotRoot,
    }),
  };
}
