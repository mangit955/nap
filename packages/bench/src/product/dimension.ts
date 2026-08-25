/**
 * The nine axes the product half is graded on, and the one that is reported but never scored.
 *
 * These are *dimensions*, not categories, and not checks. A check asks a question with a
 * yes-or-no answer and is answered by a machine; a dimension asks how good something is and is
 * answered by a judge on the ordinal scale in `grade.ts`. Two words because they are two
 * different kinds of claim, and collapsing them would let a judgement be read as a measurement.
 *
 * **Equally weighted, deliberately.** Any weighting we picked here would be our own aesthetic
 * theory compiled in — that hierarchy matters more than interaction, say — and the brief this
 * was built to is explicit that nothing should favour a particular design approach. Equal
 * weights encode no theory. Absent dimensions renormalise out, so a task with no interactive
 * surface is scored over the eight that applied rather than docked for the ninth.
 *
 * **There is no icon dimension, and that is a decision.** Icon overuse is a real problem in
 * generated interfaces, but naming a dimension after it would bake a specific component library
 * into the rubric and make the benchmark measure adherence to our taste rather than whether the
 * product is good. It belongs under `restraint`, where the question is whether a decision earns
 * its place — which is the same question a gradient, a shadow or a card has to answer. The
 * rubric handed to the judge requires icon usage to be *stated* under `restraint` on every run,
 * so it stays visible even when the answer is "fine".
 */

import { z } from "zod";

/**
 * Canonical order, used everywhere dimensions are listed.
 *
 * From the order a person reads an interface in — what draws the eye, then what the words do,
 * then how it is arranged — rather than alphabetically, because a report is read top to bottom
 * and an alphabetical list would open on `color`.
 */
export const PRODUCT_DIMENSIONS = [
  /** What reads first, second, third — and whether that ranking is the right one. */
  "hierarchy",
  /** Type scale, weight, measure, and whether the steps between sizes do any work. */
  "typography",
  /** Rhythm and alignment: consistent spacing steps, things lining up, breathing room earned. */
  "spacing",
  /** Palette intent and contrast — whether colour carries meaning or is applied as decoration. */
  "color",
  /** Structure and information density: is the page arranged for its content or from a template. */
  "layout",
  /** Component quality and consistency: are the same things built the same way, and built well. */
  "components",
  /** Affordance, state and clarity: can a person tell what is interactive and what just happened. */
  "interaction",
  /** Whether the small viewport is designed for, rather than the large one squashed. */
  "responsiveness",
  /**
   * Whether every visual decision earns its place.
   *
   * Not a ban list. A gradient, a rounded card, a shadow or an icon can each be the right call;
   * the question is whether this one improves the product or is decoration applied because it
   * was available. Where icon usage is judged.
   */
  "restraint",
] as const;

export const ProductDimensionSchema = z.enum(PRODUCT_DIMENSIONS);
export type ProductDimension = z.infer<typeof ProductDimensionSchema>;

/**
 * The judge's holistic read of the whole product — reported, never averaged in.
 *
 * It is kept out of `PRODUCT_DIMENSIONS` rather than excluded by a rule in the scorer, because a
 * rule can be forgotten and a type cannot: `scoreProduct` folds over `PRODUCT_DIMENSIONS`, and
 * polish is simply not in it. Averaging it would double-count — it is a summary of the nine —
 * and it is the least evidence-anchored thing the judge produces, so letting it dominate nine
 * grounded grades would be the wrong way round.
 *
 * Its value is the *disagreement*. When the holistic read is much worse than the computed mean,
 * something is wrong with an interface that the nine dimensions did not ask about, and that is
 * a signal the rubric is incomplete rather than a number to fold in.
 */
export const POLISH = "polish" as const;

/** A short description of each dimension, for the rubric and for report formatting. */
export const DIMENSION_SUMMARIES = {
  hierarchy: "what reads first, and whether that is the right thing",
  typography: "scale, weight and measure, and whether the steps do work",
  spacing: "rhythm, alignment, and whether whitespace is earned",
  color: "whether colour carries meaning or is decoration",
  layout: "structure and density: arranged for this content, or from a template",
  components: "quality and consistency of the pieces the interface is built from",
  interaction: "affordance, state, and whether a person can tell what happened",
  responsiveness: "whether the small viewport is designed for, not squashed",
  restraint: "whether each visual decision — including every icon — earns its place",
} as const satisfies Record<ProductDimension, string>;
