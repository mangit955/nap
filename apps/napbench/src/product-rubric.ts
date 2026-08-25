/**
 * What a judge is told, and the version stamp that makes two judgements comparable.
 *
 * **The rubric lives here rather than in `@nap/bench`, and that is the same decision as the port.**
 * `product/judgement.ts` is explicit that nothing provider-shaped appears in the seam — no model
 * id, no prompt, no threshold — because none of it distinguishes one judgement from another once
 * it has been made. A prompt is how *this* judge was asked; a scripted judge is asked nothing at
 * all and produces the identical shape. So the rubric belongs beside the adapter that sends it.
 *
 * **It is generated from `PRODUCT_DIMENSIONS`, not typed out beside it.** A rubric that listed the
 * nine dimensions in prose would be a second copy of the list, and the copy that drifts is always
 * the one nobody folds over: a dimension added to the enum and forgotten here would be demanded by
 * the schema and never explained to the judge, which produces a confident guess rather than an
 * error. The one thing written by hand is what each dimension *asks*, and that already lives in
 * `DIMENSION_SUMMARIES`.
 *
 * **`rubricVersion` is what makes two runs comparable, and it is why the wording is not free to
 * change quietly.** The same model against a reworded rubric is a different instrument, and a
 * score taken under one is not a score taken under the other — so `compare` refuses the pairing.
 * Bump the version whenever the text below changes in a way that could move a grade; a typo fix
 * need not, and anything that adds, removes or re-argues a dimension must.
 */

import { DIMENSION_SUMMARIES, POLISH, PRODUCT_DIMENSIONS } from "@nap/bench/product/dimension";
import { CONFIDENCE_LEVELS, GRADES } from "@nap/bench/product/grade";

/**
 * The instrument's version, recorded on every judgement and checked by `compare`.
 *
 * A bare ordinal rather than a hash of the text below. A hash would bump itself on a whitespace
 * change and silently split an archive in two; a number is somebody deciding that the question
 * being asked has changed, which is the fact a comparison actually needs.
 */
export const PRODUCT_RUBRIC_VERSION = "product-2";

/**
 * What each grade means, in the judge's own terms.
 *
 * Anchored to what a person would say about an interface rather than to a number: the numbers are
 * applied afterwards, in `grade.ts`, precisely so the judge never sees them. A judge shown `95`
 * beside `excellent` starts arithmetic, and arithmetic is what the ordinal scale exists to stop.
 */
const GRADE_MEANINGS: Record<(typeof GRADES)[number], string> = {
  excellent: "considered and deliberate; a person would assume a designer was involved",
  good: "solid and coherent, with a weakness or two a careful eye would find",
  moderate: "serviceable; nothing is broken, and nothing was decided either",
  weak: "visibly unconsidered — defaults, accidents, or decoration standing in for structure",
  poor: "actively bad: the design gets in the way of using the thing",
};

/**
 * The whole of what the judge is told about how to grade.
 *
 * Sent as the system prompt. The application's own single sentence of intent, and the images,
 * go in the user message — see `vision-judge.ts`, which is also where the refusals the prompt
 * merely *requests* are actually enforced.
 */
export const PRODUCT_RUBRIC = [
  "You are grading the design quality of a finished web application from screenshots alone.",
  "",
  "You are not being asked whether it does what it was supposed to do. Something else measures",
  "that, with checks that cannot be talked round, and you have not been shown the specification",
  "on purpose: the question here is the one a person has when they open the finished thing.",
  "",
  "What you can see is what there is. You have no source, no dependency list and no way to tell",
  "which component library was used, if any. Do not guess at one, and do not reward or penalise",
  "an application for looking like it used a particular set of components — an interface that",
  "shipped its library's defaults unchanged has still made no decisions, and that is the thing",
  "worth saying about it.",
  "",
  "Do not grade accessibility conformance. Contrast ratios, focus order and labelling are audited",
  "separately by a machine, and a second opinion here would double-count them. Colour is graded on",
  "whether it carries meaning, not on whether it passes an audit.",
  "",
  "## The scale",
  "",
  "Every grade is one of these words, and nothing else:",
  "",
  ...GRADES.map((grade) => `- ${grade}: ${GRADE_MEANINGS[grade]}`),
  "",
  "Use the whole of it. Most interfaces are not good, and a judge whose every answer is `good` or",
  "`moderate` has reported their own uncertainty rather than described the artefact. `good` means",
  "a careful eye finds a weakness or two and nothing more; `excellent` is rare. If a page is",
  "carrying an obvious fault, the grade for the dimension that fault belongs to is at the bottom",
  "of the scale and not in the middle of it.",
  "",
  "Use `not_assessable` only when you had nothing to look at — a surface that never rendered, or",
  "a dimension the application gives no evidence about at all. It is not a bad grade, and it is",
  "not a way to avoid committing to one. A dimension you can see and are unsure about is graded,",
  `with a \`confidence\` of ${CONFIDENCE_LEVELS.join(", ")} saying how sure you are.`,
  "",
  "## The dimensions",
  "",
  "Answer every one of these. A dimension you leave out is not a neutral omission — it shrinks the",
  "denominator and raises the score.",
  "",
  ...PRODUCT_DIMENSIONS.map((dimension) => `- ${dimension}: ${DIMENSION_SUMMARIES[dimension]}`),
  "",
  "Three of them need saying more precisely.",
  "",
  "`hierarchy` is about ranking, not about decoration. You have been told in one sentence what",
  "this application is for. If the thing it is for is not what reads first — if the work is below",
  "the fold and the space above it is spent on introducing the application to somebody who has",
  "already opened it — that is a hierarchy failure, however handsome the part you see is.",
  "",
  "`responsiveness` is about whether the small viewport was designed for or the large one was",
  "squashed. Grade it by comparing one surface across the two sizes you were given. Do not mark a",
  "mobile screenshot down for being narrow; mark it down for being the desktop layout clipped.",
  "",
  "`restraint` asks whether each visual decision earns its place. This is not a list of banned",
  "things: a gradient, a shadow, a rounded card or an icon can each be exactly the right call. The",
  "question is always whether this particular one improves the product or is decoration applied",
  "because it was available. Ask it device by device, and ask where each one is *used*: a treatment",
  "applied to one thing marks that thing out, and the same treatment applied to everything",
  "distinguishes nothing and is decoration by another name. State what the application does with",
  "icons under this dimension every time, including when the answer is that it uses them sparingly",
  "and well.",
  "",
  `Finally, grade \`${POLISH}\`: your holistic read of the whole product, as a single judgement`,
  "rather than a summary of the nine above. It is reported and never averaged in, so say what you",
  "actually think.",
  "",
  "## Evidence",
  "",
  "Every grade you give must cite at least one screenshot, named by its surface and viewport, with",
  "an observation of what is actually in the image. An observation describes the artefact — `the",
  "heading and the body text differ only in weight` — rather than restating the verdict — `the",
  "typography is weak`. A reader will check your evidence against the picture, so cite only what",
  "is visible in the one you name.",
  "",
  "Answer by calling the tool. Do not write anything outside it.",
].join("\n");
