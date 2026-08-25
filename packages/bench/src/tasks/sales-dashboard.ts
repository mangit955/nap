/**
 * A week of a small shop's trading, and nothing said about how to show it.
 *
 * The second task described by outcome, and the one that asks a different question of the model
 * than `reading-list` does. That task is a *tool*: it is judged on what happens when somebody uses
 * it. This one is read rather than used — every figure is on screen the moment it loads — so what
 * is being measured is whether the model can decide what matters and arrange a screen around that
 * answer. A dashboard is where a generated interface most reliably gives up and emits a table.
 *
 * **The data is seeded, and that is what makes the checks fair.** A task described by outcome may
 * only assert behaviour and its own data — see `benchmark-tasks.test.ts` — and this task has no
 * behaviour to assert: nothing is typed and nothing is clicked. Supplying the week in a file is
 * what leaves anything objective to check at all, and the prompt says plainly that those figures
 * are the ones on sale, so an application asserting them back is being held to what it was given
 * rather than to wording somebody guessed at.
 *
 * **The one thing the prompt pins about presentation** is that the figures have to be readable as
 * figures rather than only as a picture of them. That is a statement about the product — somebody
 * reconciling a till at seven in the morning needs the number — and it is what makes asserting a
 * count fair. Without it a bar chart with no labels would be a defensible design and would fail a
 * check, which is a benchmark measuring luck.
 */

import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { defineTask } from "../task.ts";
import { TEMPLATE_PREVIEW_PORT, TEMPLATE_PREVIEW_TIMEOUT_MS } from "./template.ts";

/**
 * The week, as a module the agent imports rather than as prose in the prompt.
 *
 * Deliberately more than fits comfortably on a phone: seven days and four drinks is enough that
 * *something* has to be decided about what leads and what follows, which is the whole subject of
 * the `hierarchy` and `layout` grades. Every number is under a thousand, which is not incidental —
 * a check asserting `4820` would fail an application that quite properly wrote `4,820`, and a
 * benchmark that punishes thousands separators is measuring our formatter rather than their
 * product.
 */
const WEEK_SOURCE = `export type Day = {
  day: string;
  takings: number;
  customers: number;
};

export type Drink = {
  name: string;
  sold: number;
};

export const DAYS: Day[] = [
  { day: "Monday", takings: 412, customers: 96 },
  { day: "Tuesday", takings: 388, customers: 91 },
  { day: "Wednesday", takings: 455, customers: 108 },
  { day: "Thursday", takings: 501, customers: 117 },
  { day: "Friday", takings: 634, customers: 149 },
  { day: "Saturday", takings: 720, customers: 168 },
  { day: "Sunday", takings: 296, customers: 74 },
];

export const DRINKS: Drink[] = [
  { name: "Flat white", sold: 268 },
  { name: "Filter", sold: 191 },
  { name: "Cortado", sold: 143 },
  { name: "Hot chocolate", sold: 87 },
];
`;

/**
 * Every drink in the seeded week, which the prompt says are the ones that sold.
 *
 * Written out rather than derived from the source above, which is a second copy and therefore
 * something that can drift. It cannot drift silently: `benchmark-tasks.test.ts` holds every
 * product task to asserting only strings it typed in or seeded, so renaming a drink in the file
 * and not here fails a test rather than quietly checking for something nobody was given.
 */
const DRINK_NAMES = ["Flat white", "Filter", "Cortado", "Hot chocolate"] as const;

export const SALES_DASHBOARD_TASK = defineTask({
  id: "sales-dashboard",
  name: "A week of trading, on one screen somebody would actually read",
  intent: "how a small coffee shop's week went, for the person who runs it",
  prompts: [
    [
      "The person who runs a small coffee shop opens this on their phone before unlocking the",
      "door, and again on a laptop at the end of the week.",
      "Last week's trading is in src/week.ts: takings and customers for each day, and how many",
      "of each drink sold.",
      "They want to know how the week went without reading it row by row — and they need the",
      "actual figures, not only a picture of them.",
      "Those numbers are the real ones: do not invent, round or rename anything in that file.",
      "Design and build it as a product you would be happy to ship: you decide what leads, what",
      "follows, and what it all looks like.",
    ].join("\n"),
  ],
  environment: { files: [{ path: "src/week.ts", contents: WEEK_SOURCE }] },
  preview: { port: TEMPLATE_PREVIEW_PORT, timeoutMs: TEMPLATE_PREVIEW_TIMEOUT_MS },
  /**
   * One surface, and one is honest here: everything this application has to say is on screen when
   * it loads, so a second would be the same photograph twice. `interaction` will come back
   * `not_assessable` on most runs, which renormalises rather than costing the run a grade — the
   * behaviour `surface.ts` and `product-score.ts` were built for, exercised for the first time by
   * a task that genuinely has no interactive surface.
   */
  surfaces: [{ id: "overview" }],
  checks: [
    {
      id: "build",
      kind: "command",
      command: `cd ${PROJECT_ROOT_PATH} && bun run build`,
      // The gate: no judgement can rescue an application that does not compile, and the cap is
      // what says so before the two halves are ever combined.
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
      // At the size the prompt says this is opened at first. A dashboard's usual accessibility
      // failure is a figure rendered as decorative markup with no name, which is exactly the
      // thing an audit finds and no assertion above would.
      viewport: "mobile",
      failOn: "serious",
    },
    {
      id: "shows-every-drink",
      kind: "browser",
      steps: [
        ...DRINK_NAMES.map((name) => ({ step: "expectText" as const, text: name })),
        // Last, so it covers whatever rendering the figures caused rather than only the load.
        { step: "expectNoConsoleErrors" },
      ],
    },
    {
      id: "shows-the-figures-themselves",
      kind: "browser",
      /**
       * The counts, which is a different claim from the names above and fails separately.
       *
       * Two of them rather than one, and deliberately the largest and the smallest: an
       * application that leads on its best seller and quietly drops the tail is the commonest
       * way a generated dashboard loses information, and a single assertion about the top row
       * would pass it.
       */
      steps: [
        { step: "expectText", text: "268" },
        { step: "expectText", text: "87" },
      ],
    },
    {
      id: "fits-on-a-phone",
      kind: "browser",
      viewport: "mobile",
      /**
       * The objective half of "works on a phone", kept apart from the judged one. Whether the
       * small viewport was designed for or the large one squashed is graded under
       * `responsiveness`; whether anything spills past the edge is two numbers compared. A wide
       * table is how a dashboard fails this, and it is the failure the prompt's first sentence
       * exists to make expensive.
       */
      steps: [{ step: "expectNoHorizontalOverflow" }],
    },
  ],
});
