/**
 * The four axes a check can speak to, and how much each is worth.
 *
 * A category is a property of a *check*, not of a check kind: `bun run build` and
 * `bun run lint` are both commands and are not both functional, which is exactly why the
 * default is overridable. See the glossary in `CONTEXT.md`.
 */

import { z } from "zod";

/**
 * Canonical order, used wherever categories are listed.
 *
 * Reports are diffed against each other, so the order has to come from here rather than from
 * whatever order a task happened to declare its checks in — otherwise two runs of the same
 * task produce reports that differ only by arrangement.
 */
export const CATEGORIES = ["functional", "browser", "visual", "code"] as const;

export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

/**
 * Relative worth of each category, before renormalisation.
 *
 * Percentages rather than fractions because that is how they are talked about, and they are
 * only ever used as ratios — a vector that does not sum to 100 is rescaled like any other.
 */
export const CategoryWeightsSchema = z.strictObject({
  functional: z.number().nonnegative(),
  browser: z.number().nonnegative(),
  visual: z.number().nonnegative(),
  code: z.number().nonnegative(),
});

export type CategoryWeights = z.infer<typeof CategoryWeightsSchema>;

/**
 * Functional dominates deliberately: an application that does not do what was asked is a
 * failure however well it is written or laid out.
 */
export const DEFAULT_CATEGORY_WEIGHTS: CategoryWeights = {
  functional: 50,
  browser: 25,
  visual: 15,
  code: 10,
};

/**
 * Where a check scores when its task does not say.
 *
 * Only the kinds that exist appear here. A default for a kind nobody can write yet would be
 * a guess recorded as a decision.
 */
export const DEFAULT_CATEGORY_FOR_KIND = {
  command: "functional",
  /**
   * A browser check defaults to the axis of the same name, and overriding it is again the
   * ordinary case rather than the exception: "the to-do appears after the button is pressed"
   * is functional, and "nothing overflows at 375px" is not.
   */
  browser: "browser",
  /**
   * An accessibility audit scores into `code`, not `browser`, and the pull is towards the
   * wrong answer here because the audit *needs* a browser to run.
   *
   * But a category is a property of what a check measures rather than of how it measures it.
   * `browser` is "does the application behave correctly when driven"; an audit drives nothing
   * and asserts no behaviour. What it reports is the quality of the markup that was written —
   * missing labels, unnamed controls, contrast — judged by an established tool rather than by
   * our opinion, which is the same shape of claim as the typecheck sitting beside it.
   */
  accessibility: "code",
} as const satisfies Record<"command" | "browser" | "accessibility", Category>;
