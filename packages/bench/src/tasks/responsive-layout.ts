/**
 * The same page, asserted at two sizes, where the two sizes must disagree.
 *
 * **Two checks rather than one, because the viewport is a field on a check.** Writing the mobile
 * and desktop sequences as one check would mean resizing mid-sequence and asserting both states in
 * one result — and one result cannot say "it works on desktop and not on mobile", which is the
 * single most useful thing this task has to report.
 *
 * **The assertions are the difference, not the presence.** Checking only that the links exist at
 * both widths would pass for a page that ignores the viewport entirely. So desktop asserts there
 * is *no* menu button and mobile asserts the links are *not* visible until it is pressed: an
 * implementation that renders one fixed layout fails one of the two whichever layout it picked.
 *
 * Horizontal overflow is asserted at both, and it is the one objective stand-in for "works on a
 * phone" this benchmark has. It is a measurement — two numbers from the port, compared by
 * `browser-executor` — rather than anybody's opinion about the layout.
 */

import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { defineTask } from "../task.ts";
import { TEMPLATE_PREVIEW_PORT, TEMPLATE_PREVIEW_TIMEOUT_MS } from "./template.ts";

/**
 * How long an absence assertion waits.
 *
 * Short deliberately: proving a negative costs the whole deadline, and this task makes four such
 * assertions. At the default that is a minute of waiting for things that were never going to
 * appear — and a hidden element is hidden from the first paint, so there is nothing to wait for.
 */
const ABSENCE_TIMEOUT_MS = 2_000;

const MENU = { by: "role", role: "button", name: "Menu" } as const;
const HOME = { by: "role", role: "link", name: "Home" } as const;

export const RESPONSIVE_LAYOUT_TASK = defineTask({
  id: "responsive-layout",
  name: "A navigation bar that behaves differently on a phone",
  prompts: [
    [
      "Build a single page with a navigation bar at the top.",
      'The bar contains three links whose accessible names are "Home", "Pricing" and "About",',
      "each pointing at this same page.",
      "On viewports narrower than 640px the three links must be hidden, and a button whose",
      'accessible name is "Menu" must be shown instead; pressing it reveals the three links.',
      'On viewports 640px and wider the three links must be visible and the "Menu" button must',
      "not be visible.",
      "The page must never scroll sideways at any width.",
    ].join("\n"),
  ],
  preview: { port: TEMPLATE_PREVIEW_PORT, timeoutMs: TEMPLATE_PREVIEW_TIMEOUT_MS },
  checks: [
    {
      id: "build",
      kind: "command",
      command: `cd ${PROJECT_ROOT_PATH} && bun run build`,
      build: true,
    },
    {
      id: "typecheck",
      kind: "command",
      command: `cd ${PROJECT_ROOT_PATH} && bunx tsc --noEmit`,
      // On every task in the benchmark, and that is the reason rather than an interest in this
      // one's tidiness: a task with no `code` check renormalises its categories over a different
      // set, and its score would not be on the same scale as the other three.
      category: "code",
    },
    {
      id: "desktop-shows-the-links",
      kind: "browser",
      viewport: "desktop",
      steps: [
        { step: "expectVisible", selector: HOME },
        { step: "expectVisible", selector: { by: "role", role: "link", name: "Pricing" } },
        { step: "expectVisible", selector: { by: "role", role: "link", name: "About" } },
        // A count of zero rather than a "not visible" assertion, because the port has no such
        // step and this says the same thing in terms it can already answer: nothing visible
        // matches. It pays the absence timeout, hence the short one.
        //
        // Note this counts *visible* elements, so a desktop layout that renders the button and
        // hides it passes. The prompt is worded to match — "must not be visible" rather than
        // "must not exist" — because a benchmark may only demand what it is able to measure.
        { step: "expectCount", selector: MENU, count: 0, timeoutMs: ABSENCE_TIMEOUT_MS },
        { step: "expectNoHorizontalOverflow" },
      ],
    },
    {
      id: "mobile-collapses-the-links",
      kind: "browser",
      viewport: "mobile",
      steps: [
        { step: "expectVisible", selector: MENU },
        // Hidden, not absent: a layout that renders the links and hides them with CSS is a
        // correct implementation, and `count` filters to what a user can actually see — so
        // this passes for both approaches and fails only for a bar that ignores the width.
        { step: "expectCount", selector: HOME, count: 0, timeoutMs: ABSENCE_TIMEOUT_MS },
        { step: "click", selector: MENU },
        { step: "expectVisible", selector: HOME },
        { step: "expectVisible", selector: { by: "role", role: "link", name: "Pricing" } },
        { step: "expectVisible", selector: { by: "role", role: "link", name: "About" } },
        // After the menu is open, which is the state most likely to push something off-screen.
        { step: "expectNoHorizontalOverflow" },
      ],
    },
  ],
});
