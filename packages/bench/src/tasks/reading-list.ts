/**
 * The first task described by its outcome rather than by its interface — and the first that is
 * judged on how it looks as well as on what it does.
 *
 * **Why the prompt does not pin strings.** Every task in the frozen suite quotes the exact
 * heading, label and button name its checks look for, because a check asserting a string nobody
 * asked for is measuring luck. That discipline made those tasks fair and made them a
 * specification: an agent that types out what it was told does well, and nothing about product
 * judgement is being exercised at all. Here the prompt says what somebody should be able to *do*,
 * and the checks assert only two things a benchmark is entitled to assert without being told: the
 * application echoes back text the check itself typed, and it does not spill off a phone.
 *
 * That is what leaves room to be measured. The agent chooses the words, the structure and the
 * layout, and the half of the score that asks whether those choices were any good is the product
 * judge's — see `intent` below and `packages/bench/src/product/`.
 *
 * **The one thing the prompt does pin is a keystroke**, and it is a statement about the product
 * rather than about the implementation: adding something takes a title and the Enter key. A check
 * has to be able to reach the populated state without guessing what a button is called, and
 * "saving something is one keystroke" is an outcome a person would ask for.
 */

import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { BrowserStep } from "../browser-check.ts";
import { defineTask } from "../task.ts";
import { TEMPLATE_PREVIEW_PORT, TEMPLATE_PREVIEW_TIMEOUT_MS } from "./template.ts";

/**
 * What a check types in, and the only string it then asserts on.
 *
 * The check's own data rather than something the agent was told, which is what makes asserting
 * it fair — the same exemption `benchmark-tasks-behaviour.test.ts` already draws for typed text.
 */
const AN_ARTICLE = "Why tidal locking happens";

/** Whatever the application takes a title in. The role, not a name nobody promised. */
const TITLE_FIELD = { by: "role", role: "textbox" } as const;

/**
 * Saving one article, as the prompt describes saving one: type the title, press Enter.
 *
 * Written once and reused by every check and by the populated surface, because it is one claim
 * about the product — "adding something is a keystroke" — and four copies of it would be four
 * places to update on the day that claim changes.
 */
const SAVE_AN_ARTICLE = [
  { step: "fill", selector: TITLE_FIELD, value: AN_ARTICLE },
  { step: "press", key: "Enter" },
] as const satisfies readonly BrowserStep[];

export const READING_LIST_TASK = defineTask({
  id: "reading-list",
  name: "A reading list somebody would want to keep using",
  intent: "a place to keep the articles you mean to read, and to see what you have finished",
  prompts: [
    [
      "Build a reading list.",
      "Somebody saves articles they mean to read later, comes back to it over weeks, and wants",
      "to see at a glance what is still unread and what they have finished.",
      "Saving one is a single keystroke: they type the title into the field on the page and",
      "press Enter. What they saved is still there when they come back to the page.",
      "It is opened as often on a phone as on a laptop.",
      "Design and build it as a product you would be happy to ship: you decide the wording, the",
      "structure and the layout.",
    ].join("\n"),
  ],
  preview: { port: TEMPLATE_PREVIEW_PORT, timeoutMs: TEMPLATE_PREVIEW_TIMEOUT_MS },
  /**
   * What the judge is shown: the application before anything is in it, and after something is.
   *
   * Both, because an empty state is where a generated interface is most often thoughtless and
   * where the difference between a product and a scaffold is most visible — and because a
   * populated list is the only one of the two that says anything about hierarchy or density.
   * Each is photographed at both sizes; see `surface.ts`.
   */
  surfaces: [
    { id: "empty" },
    {
      id: "populated",
      steps: [...SAVE_AN_ARTICLE],
    },
  ],
  checks: [
    {
      id: "build",
      kind: "command",
      command: `cd ${PROJECT_ROOT_PATH} && bun run build`,
      // The gate as well as the check: no judgement can rescue an application that does not
      // compile, and the cap is what says so before the halves are ever combined.
      build: true,
    },
    {
      id: "typecheck",
      kind: "command",
      // The compiler directly rather than the project's script, which is a file the agent can
      // edit — a grader that asks a project how to grade it is not grading it.
      command: `cd ${PROJECT_ROOT_PATH} && bunx tsc --noEmit`,
      category: "code",
    },
    {
      id: "is-accessible",
      kind: "accessibility",
      /**
       * Audited at the small size, which is the one the prompt says this is opened on and the
       * one a generated layout is most likely to get wrong. Accessibility stays objective and
       * is scored here only: the judge is never asked to re-score it, because one thing wants
       * one authority.
       */
      viewport: "mobile",
      failOn: "serious",
    },
    {
      id: "keeps-what-you-add",
      kind: "browser",
      steps: [
        ...SAVE_AN_ARTICLE,
        { step: "expectText", text: AN_ARTICLE },
        // Last, so it covers what the interaction caused rather than only the page load.
        { step: "expectNoConsoleErrors" },
      ],
    },
    {
      id: "still-there-when-you-come-back",
      kind: "browser",
      steps: [
        ...SAVE_AN_ARTICLE,
        { step: "expectText", text: AN_ARTICLE },
        // The whole assertion. An application that saved what it was shown and one that merely
        // appeared to are indistinguishable until this point.
        { step: "reload" },
        { step: "expectText", text: AN_ARTICLE },
      ],
    },
    {
      id: "fits-on-a-phone",
      kind: "browser",
      viewport: "mobile",
      /**
       * The objective half of "works on a phone", deliberately kept apart from the judged one.
       *
       * Nothing spills past the right-hand edge is a measurement — two numbers from the port,
       * compared. Whether the small viewport was *designed for* or the large one squashed is a
       * judgement, and it is graded under `responsiveness`. Measuring the same subject twice is
       * the point: neither answer can stand in for the other.
       */
      steps: [...SAVE_AN_ARTICLE, { step: "expectNoHorizontalOverflow" }],
    },
  ],
});
