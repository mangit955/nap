/**
 * Nine hand-written applications an evaluator has to be able to tell apart.
 *
 * **Why a corpus exists at all.** The product half is a judge's opinion turned into arithmetic,
 * and an opinion nobody has watched discriminate is a check that has never been observed failing
 * — it may be quietly returning `moderate` to everything and no report would look any different.
 * The only way to know is to hand it applications whose *relative* quality is not in dispute and
 * see whether the grades come back in the order a person would put them in.
 *
 * **Static, hand-written, and photographed once.** No sandbox, no model, no agent: the fixtures
 * are single files of HTML with their CSS inline, committed beside two PNGs each, in
 * `apps/napbench/fixtures/corpus/`. That keeps the corpus free and deterministic, which matters
 * more here than realism — the same nine images every time is what makes "the judge changed" a
 * legible result rather than "the applications changed and so did the judge". Harvesting real
 * screenshots from funded runs into the same shape is the follow-up, and `docs/NAPBENCH.md`
 * describes it; it does not replace these, because a generated application is a moving target.
 *
 * **One application, nine designs.** Every fixture renders the same task tracker over the same five
 * tasks, and every one is described to the judge by the same single sentence — a constant here
 * rather than a field, because a judge told nine slightly different things about nine applications
 * is nine slightly different experiments rather than one with nine arms.
 *
 * Within the two *design* pairs the control is stricter than that, and deliberately: the markup of
 * `desktop-only-breaks-mobile` and `responsive-strong` is identical and only their stylesheets
 * differ, and `icons-restrained` is `excessive-icon`'s page with the icons taken out. A pair that
 * also differed in layout or content would let a judge satisfy the bound by grading the difference
 * instead of the thing the bound is about.
 *
 * The third pair is not a design pair and does not have that property. `correct-ugly` and
 * `broken-beautiful` differ in *what works*, which is invisible in a photograph — one carries
 * filters and a working form, the other a summary row and dead controls — and that difference is
 * the variable rather than a confound. What is asserted about them is only that the polished one
 * wins on the half a judge can see.
 *
 * **What is a fixture and what is an expectation are kept apart.** This file says what exists;
 * `discrimination.ts` says what the grades must do. A corpus that grew a tenth fixture nobody
 * asserted anything about would still be worth photographing, and an assertion whose fixture went
 * missing is caught by a test rather than silently never evaluated.
 */

import { CAPTURE_VIEWPORTS, DEFAULT_SURFACE_ID } from "../surface.ts";
import type { ViewportName } from "../viewport.ts";
import type { SurfaceScreenshot } from "./evaluation.ts";

/**
 * The one sentence a judge is told about every fixture, and the whole of what it is told.
 *
 * Neutral, and about the application rather than about how it should look — the same rule
 * `product/evaluation.ts` states for a task's `intent`, for the same reason: a judge shown a
 * specification starts grading feature completion, which the objective half measures better.
 */
export const CORPUS_INTENT =
  "A small team's task tracker: the work currently on the board, what state each item is in, and a way to add another.";

/**
 * A fixture: a directory name, and the thing it exists to separate.
 *
 * `built` is prose rather than a machine-readable claim on purpose. What a fixture is *for* is an
 * argument to a human reader deciding whether the corpus is fair; what it must *score* is an
 * expectation in `discrimination.ts`, and conflating the two would let a fixture's own description
 * quietly become the thing being asserted.
 *
 * It is still what an expectation is *read out of*, and the difference matters. The three
 * dimensions the two ends of the corpus are asserted to differ on came from `ai-slop-generic`'s
 * description below, which was written before any of it was measured. A person read that prose
 * and wrote three expectations; nothing reads it at run time, so a fixture whose description
 * changed would not silently change what is claimed about it. That is the line between reading
 * and conflating — and it is worth saying that the reading is a judgement rather than a
 * derivation, since "a purple hero gradient" could have been filed under `color` as easily as
 * under `restraint`. See `docs/napbench-corpus-margin.md`.
 */
export type CorpusFixture = {
  id: string;
  built: string;
};

export const CORPUS_FIXTURES = [
  {
    id: "minimalist-professional",
    built:
      "Restrained and deliberate: one accent, a real type scale, generous but earned space. The top of the corpus, and the thing everything else is measured against.",
  },
  {
    id: "ai-slop-generic",
    built:
      "The generated-interface house style: a purple hero gradient, emoji headings, three identical centred cards, everything centred. The bottom of the corpus. The tasks themselves are pushed below the fold by the marketing, which is not an artefact of photographing a viewport — it is the failing, and the photograph is what a person opening it sees.",
  },
  {
    id: "excessive-gradient",
    built:
      "A gradient on every surface — page, header, cards, buttons, badges — so nothing recedes and no gradient means anything. Tests whether `restraint` notices decoration that is applied rather than chosen.",
  },
  {
    id: "excessive-icon",
    built:
      "An icon beside every label, button, heading and list item, several of them unrelated to what they sit next to. There is no icon dimension, deliberately, so this must land under `restraint`.",
  },
  {
    id: "icons-restrained",
    built:
      "`excessive-icon`'s page with the icons taken out, bar two that each carry meaning a word would not. The same structure, the same stylesheet and the same words — what differs is the glyphs, and the one row action that a column of four of them had replaced. A judge that has learned `icons are bad` rather than `decoration must earn its place` marks this down too.",
  },
  {
    id: "desktop-only-breaks-mobile",
    built:
      "A fixed-width layout with no media query: fine at 1280, horizontally scrolling and clipped at 375. Its markup is byte-for-byte `responsive-strong`'s, so the pair differs only in a stylesheet. Tests `responsiveness` against a mobile capture that is plainly the desktop one squashed.",
  },
  {
    id: "responsive-strong",
    built:
      "The other half of the responsive pair: byte-for-byte the same markup, reflowed for the small viewport — one column, a stacked header, larger touch targets, nothing clipped. Only the stylesheets differ.",
  },
  {
    id: "correct-ugly",
    built:
      "Every feature present and working, styled with browser defaults and nothing else. The direction the geometric combination exists for: a judge that rewards completeness would score this well.",
  },
  {
    id: "broken-beautiful",
    built:
      "Carefully designed and functionally hollow — dead controls, a list that never changes. The mirror case: the judge sees screenshots only, so it should grade this well and the objective half should be what fails it.",
  },
] as const satisfies readonly CorpusFixture[];

/** The fixtures' ids as a union, so an expectation cannot name one that does not exist. */
export type CorpusFixtureId = (typeof CORPUS_FIXTURES)[number]["id"];

/**
 * Takes a bare string rather than the union, because its callers are reading ids back out of a
 * report or a directory listing — places where the value has already stopped being a literal.
 */
export function corpusFixture(id: string): CorpusFixture | undefined {
  return CORPUS_FIXTURES.find((fixture) => fixture.id === id);
}

/**
 * Where a fixture's photograph lives, relative to the corpus directory.
 *
 * Relative for the reason every path in a report is: the corpus is read from a checkout, a
 * results directory or a tarball, and only the caller knows which.
 */
export function corpusScreenshotPath(id: CorpusFixtureId, viewport: ViewportName): string {
  return `${id}/${viewport}.png`;
}

/**
 * What a judge is handed for one fixture: one surface, at both capture viewports.
 *
 * One surface rather than several, because a static file has no state to drive it into — and
 * because the pair at two sizes is the unit `responsiveness` is graded on, which is the whole
 * reason two of the nine fixtures exist. It is named `home` so that a fixture's evidence reads
 * the same way a real run's does; nothing downstream should be able to tell the two apart.
 */
export function corpusSurfaceScreenshots(id: CorpusFixtureId): SurfaceScreenshot[] {
  return CAPTURE_VIEWPORTS.map((viewport) => ({
    surfaceId: DEFAULT_SURFACE_ID,
    viewport,
    path: corpusScreenshotPath(id, viewport),
  }));
}
