/**
 * The task where no single requirement is hard and the combination is.
 *
 * The four original tasks scored 100 on functional and browser across every funded run while the
 * model still made real mistakes, which means they had stopped separating anything. This one is
 * built to separate: filtering, sorting, pagination, a derived total and persistence, each
 * trivial alone, and every check here asserts two of them *interacting*. An agent can implement
 * all five correctly in isolation and still fail every check below by paginating before it
 * filters, or by totalling the visible page instead of the matching set.
 *
 * **Difficulty comes from the requirements, not from vagueness.** Every accessible name and
 * every number a check looks for is stated in the prompt. That is deliberate: nobody wrote the
 * markup of a generated application, so a check can only address it through what the prompt
 * made it promise, and a vaguer task would measure whether the model guessed our naming rather
 * than whether it can hold five rules in its head at once.
 *
 * **Sorting is asserted through pagination, not through an ordering assertion.** The step
 * vocabulary has no "the third item is X", and adding one would be a new step kind for a single
 * task. It is not needed: with six expenses and a page size of three, changing the sort changes
 * *which three* are on page one. Asserting that is strictly better than asserting an order,
 * because an implementation that sorts the visible page rather than the whole set passes an
 * ordering check and fails this one.
 *
 * **The starting data is fixed by the prompt** so that checks can assert exact counts, exact
 * totals and exact membership without first driving a form. A task that had to add six expenses
 * through the UI before testing pagination would be measuring data entry, and would fail
 * entirely if the agent named the form differently.
 */

import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { defineTask } from "../task.ts";
import { TEMPLATE_PREVIEW_PORT, TEMPLATE_PREVIEW_TIMEOUT_MS } from "./template.ts";

/** How long an assertion that something is *absent* waits before believing it. */
const ABSENCE_TIMEOUT_MS = 2_000;

export const EXPENSE_LEDGER_TASK = defineTask({
  id: "expense-ledger",
  name: "Five simple rules that have to hold at the same time",
  prompts: [
    [
      "Build a single-page expense list application.",
      "",
      "It starts with exactly these six expenses, in this order:",
      "1. Coffee, 4, Food",
      "2. Rent, 1200, Home",
      "3. Bus fare, 3, Travel",
      "4. Groceries, 60, Food",
      "5. Lamp, 25, Home",
      "6. Train, 90, Travel",
      "",
      "It must have, exactly as written here:",
      "- the expenses rendered as list items, one per expense, each showing its name",
      '- a select whose accessible label is "Category", with the options "All", "Food", "Home"',
      '  and "Travel". Choosing one shows only expenses in that category; "All" shows every',
      "  expense and is what is chosen before anything is clicked.",
      '- a button whose accessible name is "Sort by amount". Clicking it sorts the expenses by',
      "  amount, smallest first. Clicking it again sorts them largest first. Clicking it again",
      "  goes back to smallest first. Before it is clicked at all, the expenses are in the order",
      "  listed above. The button's accessible name never changes.",
      "- at most three expenses on screen at once, with buttons whose accessible names are",
      '  "Previous" and "Next" to move between pages',
      '- the text "Page X of Y", where X is the page being shown and Y is how many pages the',
      "  expenses currently being shown need. Changing the category goes back to page 1.",
      '- the text "Total: N", where N is the sum of the amounts of every expense in the chosen',
      "  category — not just the ones on screen.",
      "",
      "The chosen category, the sort order and the page must be saved so that they survive a",
      "page reload.",
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
      category: "code",
    },
    {
      id: "starts-on-the-first-page-unsorted",
      kind: "browser",
      // The baseline every other check is a departure from. It is also the first thing a
      // pagination bug shows up in: six expenses, three at a time, two pages.
      category: "functional",
      steps: [
        { step: "expectCount", selector: { by: "role", role: "listitem" }, count: 3 },
        { step: "expectText", text: "Coffee" },
        { step: "expectText", text: "Bus fare" },
        { step: "expectNoText", text: "Train", timeoutMs: ABSENCE_TIMEOUT_MS },
        { step: "expectText", text: "Page 1 of 2" },
        { step: "expectText", text: "Total: 1382" },
      ],
    },
    {
      id: "pages-forward-and-back",
      kind: "browser",
      category: "functional",
      steps: [
        { step: "click", selector: { by: "role", role: "button", name: "Next" } },
        { step: "expectText", text: "Page 2 of 2" },
        { step: "expectText", text: "Train" },
        { step: "expectNoText", text: "Coffee", timeoutMs: ABSENCE_TIMEOUT_MS },
        // The total is over the whole category, so paging must not change it. An
        // implementation that sums what is on screen reads 175 here and fails.
        { step: "expectText", text: "Total: 1382" },
        { step: "click", selector: { by: "role", role: "button", name: "Previous" } },
        { step: "expectText", text: "Page 1 of 2" },
        { step: "expectText", text: "Coffee" },
      ],
    },
    {
      id: "filtering-repaginates-and-retotals",
      kind: "browser",
      // Three rules at once: the filter decides what is listed, how many pages there are, and
      // what the total is. Two of the three are the ones an implementation gets wrong by
      // computing them before it filters.
      steps: [
        { step: "select", selector: { by: "label", text: "Category" }, value: "Food" },
        { step: "expectCount", selector: { by: "role", role: "listitem" }, count: 2 },
        { step: "expectText", text: "Coffee" },
        { step: "expectText", text: "Groceries" },
        { step: "expectNoText", text: "Rent", timeoutMs: ABSENCE_TIMEOUT_MS },
        // One page, not two: an implementation that paginates the unfiltered list still says
        // "of 2" here while showing the right two expenses.
        { step: "expectText", text: "Page 1 of 1" },
        { step: "expectText", text: "Total: 64" },
      ],
    },
    {
      id: "sorting-changes-which-page-you-are-on",
      kind: "browser",
      // Sorting asserted through pagination — see this file's header. An application that sorts
      // only the three expenses already on screen leaves Coffee and Rent there and fails.
      steps: [
        { step: "click", selector: { by: "role", role: "button", name: "Sort by amount" } },
        { step: "expectText", text: "Bus fare" },
        { step: "expectText", text: "Lamp" },
        { step: "expectNoText", text: "Rent", timeoutMs: ABSENCE_TIMEOUT_MS },

        // And again, for largest first. The button keeps its name, so this is the same
        // selector twice — which is the prompt's requirement, checked by using it.
        { step: "click", selector: { by: "role", role: "button", name: "Sort by amount" } },
        { step: "expectText", text: "Rent" },
        { step: "expectText", text: "Train" },
        { step: "expectNoText", text: "Bus fare", timeoutMs: ABSENCE_TIMEOUT_MS },
      ],
    },
    {
      id: "filtering-and-sorting-hold-at-once",
      kind: "browser",
      // The check the whole task exists for. Neither rule may be dropped when the other is
      // applied, and the page count and total have to agree with both.
      steps: [
        { step: "select", selector: { by: "label", text: "Category" }, value: "Home" },
        { step: "click", selector: { by: "role", role: "button", name: "Sort by amount" } },
        { step: "expectCount", selector: { by: "role", role: "listitem" }, count: 2 },
        { step: "expectText", text: "Lamp" },
        { step: "expectText", text: "Rent" },
        { step: "expectNoText", text: "Coffee", timeoutMs: ABSENCE_TIMEOUT_MS },
        { step: "expectText", text: "Page 1 of 1" },
        { step: "expectText", text: "Total: 1225" },
      ],
    },
    {
      id: "changing-the-category-returns-to-page-one",
      kind: "browser",
      // The rule that only exists because two others interact: page 2 of an unfiltered list is
      // not a page of a filtered one, and an application that keeps the index shows nothing.
      steps: [
        { step: "click", selector: { by: "role", role: "button", name: "Next" } },
        { step: "expectText", text: "Page 2 of 2" },
        { step: "select", selector: { by: "label", text: "Category" }, value: "Food" },
        { step: "expectText", text: "Page 1 of 1" },
        { step: "expectText", text: "Coffee" },
      ],
    },
    {
      id: "remembers-the-category",
      kind: "browser",
      category: "functional",
      steps: [
        { step: "select", selector: { by: "label", text: "Category" }, value: "Travel" },
        { step: "expectText", text: "Total: 93" },
        // A reload rather than a second navigation: navigating again may re-mount from a fresh
        // state either way, while a reload is what a user does to find out whether it saved.
        { step: "reload" },
        { step: "expectCount", selector: { by: "role", role: "listitem" }, count: 2 },
        { step: "expectText", text: "Bus fare" },
        { step: "expectNoText", text: "Coffee", timeoutMs: ABSENCE_TIMEOUT_MS },
        { step: "expectText", text: "Total: 93" },
      ],
    },
    {
      id: "remembers-the-sort-and-the-page",
      kind: "browser",
      category: "functional",
      // The prompt asks for three things to survive a reload, and a check that only proved the
      // category would leave two of them unmeasured. Sorted ascending, page two holds
      // Groceries, Train and Rent; *unsorted*, it holds Groceries, Lamp and Train; and page one
      // sorted holds Bus fare, Coffee and Lamp. So "Rent is here and Lamp is not" is false if
      // either the sort or the page was forgotten, without needing an ordering assertion.
      steps: [
        { step: "click", selector: { by: "role", role: "button", name: "Sort by amount" } },
        { step: "click", selector: { by: "role", role: "button", name: "Next" } },
        { step: "expectText", text: "Page 2 of 2" },
        { step: "reload" },
        { step: "expectText", text: "Page 2 of 2" },
        { step: "expectText", text: "Rent" },
        { step: "expectNoText", text: "Lamp", timeoutMs: ABSENCE_TIMEOUT_MS },
        { step: "expectText", text: "Total: 1382" },
      ],
    },
    {
      id: "is-accessible",
      kind: "accessibility",
      // A select and two pagination controls is more chrome than any other task here has, and
      // an unlabelled select is what a generated one ships.
      failOn: "serious",
    },
  ],
});
