/**
 * The only task with a follow-up, and the only one that can catch a regression.
 *
 * **The regression check is not a separate check — it is the ordering.** Checks run after *every*
 * prompt has been sent, so `adds-a-todo` and `survives-a-reload` describe the first prompt's work
 * and are judged against the application the second prompt left behind. An agent that adds the
 * filter by rewriting the list and losing persistence fails them, which is precisely the question
 * a single-prompt task cannot ask. Nothing in the task file marks these as "the regression ones",
 * because the whole point is that they are ordinary checks that simply outlive the prompt that
 * earned them.
 *
 * **Every string a check looks for is quoted in a prompt**, including the accessible names, and
 * the second prompt says not to change anything else — so an agent that renames the Add button
 * while adding a filter has broken a stated requirement rather than failed a guess.
 *
 * The filter is three buttons rather than a `<select>` on purpose: a select would let a passing
 * implementation exist that never changes what is *visible*, since `selectOption` succeeding says
 * nothing about the list. Buttons plus a count assertion measures the outcome instead.
 */

import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { defineTask } from "../task.ts";
import { TEMPLATE_PREVIEW_PORT, TEMPLATE_PREVIEW_TIMEOUT_MS } from "./template.ts";

/** How long an assertion that something is *absent* waits before believing it. */
const ABSENCE_TIMEOUT_MS = 2_000;

export const TODO_CRUD_TASK = defineTask({
  id: "todo-crud",
  name: "A to-do list, then a filter that must not break it",
  prompts: [
    [
      "Build a single-page to-do list application.",
      "It must have, exactly as written here:",
      '- a text input whose accessible label is "New todo"',
      '- a button whose accessible name is "Add"',
      "- the to-dos rendered as list items, one per to-do",
      '- next to each to-do, a button whose accessible name is "Delete", which removes it',
      "Adding a to-do must clear the input.",
      "To-dos must be saved to localStorage so that they survive a page reload.",
    ].join("\n"),
    [
      "Now add filtering by completion state to the same page.",
      "Each to-do must have a checkbox whose accessible name is the text of that to-do.",
      'Add three buttons whose accessible names are "All", "Active" and "Completed".',
      "Clicking one shows only the matching to-dos: Active means not checked, Completed means",
      'checked, and All means every to-do. "All" is what the page shows before anything is',
      "clicked.",
      "Do not change anything else about the application.",
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
      id: "lint",
      kind: "command",
      command: `cd ${PROJECT_ROOT_PATH} && bun run lint`,
      category: "code",
    },
    {
      id: "adds-a-todo",
      kind: "browser",
      // Written for the first prompt, judged after the second. See this file's header.
      category: "functional",
      steps: [
        { step: "fill", selector: { by: "label", text: "New todo" }, value: "Buy milk" },
        { step: "click", selector: { by: "role", role: "button", name: "Add" } },
        { step: "expectText", text: "Buy milk" },
        { step: "expectCount", selector: { by: "role", role: "listitem" }, count: 1 },
        // The input clearing is a stated requirement and the one part of "adding worked" that
        // is invisible in the list itself.
        { step: "expectInputValue", selector: { by: "label", text: "New todo" }, equals: "" },
      ],
    },
    {
      id: "deletes-a-todo",
      kind: "browser",
      // The D of CRUD, and the second thing the follow-up prompt could plausibly break. One
      // to-do at a time, so "the Delete button" is unambiguous without the task having to
      // invent per-row accessible names the agent would have to guess the format of.
      category: "functional",
      steps: [
        { step: "fill", selector: { by: "label", text: "New todo" }, value: "Buy milk" },
        { step: "click", selector: { by: "role", role: "button", name: "Add" } },
        { step: "expectCount", selector: { by: "role", role: "listitem" }, count: 1 },
        { step: "click", selector: { by: "role", role: "button", name: "Delete" } },
        {
          step: "expectCount",
          selector: { by: "role", role: "listitem" },
          count: 0,
          timeoutMs: ABSENCE_TIMEOUT_MS,
        },
      ],
    },
    {
      id: "survives-a-reload",
      kind: "browser",
      category: "functional",
      steps: [
        { step: "fill", selector: { by: "label", text: "New todo" }, value: "Buy milk" },
        { step: "click", selector: { by: "role", role: "button", name: "Add" } },
        { step: "expectText", text: "Buy milk" },
        // A reload rather than a second navigation: navigating again may re-mount from a fresh
        // state either way, while a reload is what a user does to find out whether it saved.
        { step: "reload" },
        { step: "expectText", text: "Buy milk" },
      ],
    },
    {
      id: "filters-by-completion",
      kind: "browser",
      steps: [
        { step: "fill", selector: { by: "label", text: "New todo" }, value: "Buy milk" },
        { step: "click", selector: { by: "role", role: "button", name: "Add" } },
        { step: "fill", selector: { by: "label", text: "New todo" }, value: "Walk the dog" },
        { step: "click", selector: { by: "role", role: "button", name: "Add" } },
        { step: "expectCount", selector: { by: "role", role: "listitem" }, count: 2 },

        { step: "click", selector: { by: "role", role: "checkbox", name: "Buy milk" } },

        // The three assertions that make this about what a user sees rather than about which
        // button is highlighted: the count has to change, and change back.
        { step: "click", selector: { by: "role", role: "button", name: "Completed" } },
        { step: "expectCount", selector: { by: "role", role: "listitem" }, count: 1 },
        { step: "expectText", text: "Buy milk" },
        { step: "expectNoText", text: "Walk the dog", timeoutMs: ABSENCE_TIMEOUT_MS },

        { step: "click", selector: { by: "role", role: "button", name: "Active" } },
        { step: "expectCount", selector: { by: "role", role: "listitem" }, count: 1 },
        { step: "expectText", text: "Walk the dog" },
        { step: "expectNoText", text: "Buy milk", timeoutMs: ABSENCE_TIMEOUT_MS },

        { step: "click", selector: { by: "role", role: "button", name: "All" } },
        { step: "expectCount", selector: { by: "role", role: "listitem" }, count: 2 },
      ],
    },
  ],
});
