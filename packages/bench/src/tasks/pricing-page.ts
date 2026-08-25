/**
 * Three plans, and a page whose whole job is to make one of them the obvious choice.
 *
 * The third surface the product suite characterises a model on, and the one where design *is* the
 * function. `reading-list` is used and `sales-dashboard` is read; this one has to persuade. There
 * is almost nothing an objective check can say about whether it does — which is precisely why it
 * belongs in the suite whose second half is a judgement, and why it would have been a bad task
 * anywhere else.
 *
 * **It is the frozen `landing-page` task's opposite number, on purpose.** That task quotes the
 * heading, the body copy and the button name its checks look for, so an agent that transcribes
 * well does well and nothing about taste is exercised. Here the words on the page are the model's
 * to choose; the only strings asserted are the plans it was handed in a file, and the only reason
 * those may be asserted is that the prompt says plainly they are not to be reworded.
 *
 * **What the objective half is left with is content fidelity, accessibility and overflow**, and
 * that is the honest answer rather than a thin one. A pricing page that drops the cheapest plan,
 * ships cards no screen reader can read out, or runs off the side of a phone has failed at
 * something measurable — and everything else about it is a judgement, which the other half makes.
 */

import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { defineTask } from "../task.ts";
import { TEMPLATE_PREVIEW_PORT, TEMPLATE_PREVIEW_TIMEOUT_MS } from "./template.ts";

/**
 * What is on sale, as a module rather than as prose in the prompt.
 *
 * Three plans because two is a choice nobody agonises over and four is a table; three is where a
 * page has to decide which one it is recommending, and that decision is most of what `hierarchy`
 * is grading here. The features are uneven in length on purpose — a design that only looks right
 * when every card is the same height is a design that has not met real copy.
 */
const PLANS_SOURCE = `export type Plan = {
  name: string;
  pricePerMonth: number;
  includes: string[];
};

export const PLANS: Plan[] = [
  {
    name: "Solo",
    pricePerMonth: 0,
    includes: ["One notebook", "Web app"],
  },
  {
    name: "Studio",
    pricePerMonth: 12,
    includes: ["Unlimited notebooks", "Version history", "Web and mobile apps"],
  },
  {
    name: "Agency",
    pricePerMonth: 29,
    includes: [
      "Everything in Studio",
      "Shared workspaces",
      "Single sign-on, and someone to call when it breaks",
    ],
  },
];
`;

/**
 * The plans as the seeded file names them.
 *
 * A second copy of what the source above says, and one that cannot drift silently: every product
 * task is held to asserting only strings it typed in or seeded, so a plan renamed in the file and
 * not here fails `benchmark-tasks.test.ts` rather than checking for something nobody was given.
 */
const PLAN_NAMES = ["Solo", "Studio", "Agency"] as const;

/**
 * One feature from each plan, quoted exactly as the file has it.
 *
 * One rather than all nine: the assertion is that the page shows what a plan includes in the words
 * it was given, and nine strings would make the check a transcription exercise and its failure
 * message a wall. Chosen one per plan so that dropping a whole plan's detail fails here as well as
 * in the check above.
 */
const A_FEATURE_OF_EACH = ["One notebook", "Unlimited notebooks", "Shared workspaces"] as const;

export const PRICING_PAGE_TASK = defineTask({
  id: "pricing-page",
  name: "A pricing page somebody could actually choose from",
  intent: "the page where somebody works out which plan is theirs, and what it costs",
  prompts: [
    [
      "A small company sells a note-taking app. Build the pricing page.",
      "Somebody arrives from the marketing site knowing roughly what the product does, and",
      "leaves either having decided which plan is theirs or having decided nothing.",
      "The plans, what they cost and what each one includes are in src/plans.ts. Those are what",
      "is on sale: show all of them, and do not reword, re-price or invent any of it.",
      "It is read on a phone at least as often as on a laptop.",
      "Design and build it as a product you would be happy to ship: the wording around the",
      "plans, the structure and the layout are yours.",
    ].join("\n"),
  ],
  environment: { files: [{ path: "src/plans.ts", contents: PLANS_SOURCE }] },
  preview: { port: TEMPLATE_PREVIEW_PORT, timeoutMs: TEMPLATE_PREVIEW_TIMEOUT_MS },
  /**
   * One surface: the page, which is the whole application. A second would photograph the same
   * thing again — and a task may not photograph a scroll position, since the capture pass owns
   * what a viewport is.
   */
  surfaces: [{ id: "plans" }],
  checks: [
    {
      id: "build",
      kind: "command",
      command: `cd ${PROJECT_ROOT_PATH} && bun run build`,
      // The gate, before either half is combined: nothing judged can rescue a page that does
      // not compile.
      build: true,
    },
    {
      id: "typecheck",
      kind: "command",
      // The compiler rather than the project's script, which is a file the agent can edit.
      command: `cd ${PROJECT_ROOT_PATH} && bunx tsc --noEmit`,
      category: "code",
    },
    {
      id: "is-accessible",
      kind: "accessibility",
      // At the small size, which the prompt says is at least half of what this is read on, and
      // which is where a three-card layout is most likely to have been restacked carelessly.
      viewport: "mobile",
      failOn: "serious",
    },
    {
      id: "shows-every-plan",
      kind: "browser",
      steps: [
        ...PLAN_NAMES.map((name) => ({ step: "expectText" as const, text: name })),
        // Last, so it covers what rendering the plans caused rather than only the page load.
        { step: "expectNoConsoleErrors" },
      ],
    },
    {
      id: "says-what-each-plan-includes",
      kind: "browser",
      /**
       * A separate check from the names above, because the two fail for different reasons: a
       * page can name all three plans and show what only the recommended one includes, which
       * looks finished and leaves a visitor unable to do the one thing they came to do.
       */
      steps: A_FEATURE_OF_EACH.map((feature) => ({ step: "expectText" as const, text: feature })),
    },
    {
      id: "fits-on-a-phone",
      kind: "browser",
      viewport: "mobile",
      /**
       * The objective half of "works on a phone". Three cards side by side is the shape this
       * page most wants to be and the shape that spills off a small screen, so this is the
       * check the task's own layout invites. The judged half — designed for, or squashed — is
       * graded under `responsiveness` and is not this.
       */
      steps: [{ step: "expectNoHorizontalOverflow" }],
    },
  ],
});
