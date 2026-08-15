/**
 * The simplest real task: build one page from nothing, and have it work.
 *
 * It measures the floor rather than the ceiling — an agent that cannot do this cannot do any of
 * the others — which is why its checks are about existence and cleanliness rather than about
 * quality. There is deliberately no check for whether the page looks good: that is the visual
 * category's business, it has no judge, and inventing a proxy for it here ("has a CSS file") would
 * measure a technique rather than a result.
 *
 * **The prompt pins every string the checks look for.** That is what makes this objective: a
 * check for a heading reading "Ship faster with Nap" is only fair if the prompt said those words,
 * and a benchmark that asked for "a compelling headline" and then asserted a specific one would be
 * measuring luck. Everything the checks assert is quoted in the prompt, and nothing else is
 * asserted at all.
 */

import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { defineTask } from "../task.ts";
import { TEMPLATE_PREVIEW_PORT, TEMPLATE_PREVIEW_TIMEOUT_MS } from "./template.ts";

export const LANDING_PAGE_TASK = defineTask({
  id: "landing-page",
  name: "A landing page that renders and does not throw",
  prompts: [
    [
      "Build a single-page landing page for a product called Nap.",
      "It must contain, exactly as written here:",
      '- a top-level heading whose text is "Ship faster with Nap"',
      '- a paragraph describing the product, containing the words "describe your app"',
      '- a button whose accessible name is "Get started"',
      "Do not add routing, and do not add a second page.",
    ].join("\n"),
  ],
  preview: { port: TEMPLATE_PREVIEW_PORT, timeoutMs: TEMPLATE_PREVIEW_TIMEOUT_MS },
  checks: [
    {
      id: "build",
      kind: "command",
      command: `cd ${PROJECT_ROOT_PATH} && bun run build`,
      // The gate as well as the check: a page that does not compile cannot be most of the way
      // to good, so this failing caps the run rather than costing it one check.
      build: true,
    },
    {
      id: "lint",
      kind: "command",
      command: `cd ${PROJECT_ROOT_PATH} && bun run lint`,
      category: "code",
    },
    {
      id: "renders-the-page",
      kind: "browser",
      steps: [
        {
          step: "expectVisible",
          selector: { by: "role", role: "heading", name: "Ship faster with Nap" },
        },
        { step: "expectText", text: "describe your app" },
        { step: "expectVisible", selector: { by: "role", role: "button", name: "Get started" } },
      ],
    },
    {
      id: "throws-nothing",
      kind: "browser",
      // Its own check rather than a last step on the one above, because the two fail for
      // different reasons and a report that merged them would say "the page is wrong" when what
      // happened is that it rendered correctly and threw. Kept separate, the check list reads
      // as two findings and the score reflects two.
      steps: [{ step: "expectNoConsoleErrors" }],
    },
  ],
});
