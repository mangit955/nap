/**
 * The four tasks driven against scripted applications, to prove the checks *discriminate*.
 *
 * A task file that parses tells you nothing: a check asserting something always true would
 * validate, run, and pass every model equally. So each task here is run twice — against an
 * application that does what the prompts asked, and against one that does not — and the pair is
 * the assertion. A check that cannot fail is not a check, and this is the only place that would
 * notice.
 *
 * No Chrome, no sandbox, no network: `ScriptedBrowserSession` answers the port out of a list of
 * elements, which is exactly why the port was made narrow enough to fake. Per the ticket, the
 * tasks are authored and verified without the Playwright adapter existing.
 */

import { describe, expect, it } from "vitest";
import type { AccessibilityCheck } from "../accessibility-check.ts";
import type { BrowserCheck } from "../browser-check.ts";
import { runAccessibilityCheck, runBrowserCheck } from "../browser-executor.ts";
import type { CheckOutcome } from "../report.ts";
import type { BenchTask } from "../task.ts";
import {
  type InteractionHandler,
  ScriptedBrowserSession,
  type ScriptedBrowserSessionOptions,
  type ScriptedElement,
  type ScriptedInteraction,
  type ScriptedPageController,
} from "../testing/scripted-browser-session.ts";
import { DEBUG_BROKEN_TASK } from "./debug-broken.ts";
import { EXPENSE_LEDGER_TASK } from "./expense-ledger.ts";
import { LANDING_PAGE_TASK } from "./landing-page.ts";
import { RESPONSIVE_LAYOUT_TASK } from "./responsive-layout.ts";
import { TODO_CRUD_TASK } from "./todo-crud.ts";

const BASE_URL = "https://preview.example";

function checkNamed(task: BenchTask, id: string): BrowserCheck {
  const found = task.checks.find(
    (check): check is BrowserCheck => check.kind === "browser" && check.id === id,
  );
  if (found === undefined) throw new Error(`no browser check called ${id}`);
  return found;
}

function auditNamed(task: BenchTask, id: string): AccessibilityCheck {
  const found = task.checks.find(
    (check): check is AccessibilityCheck => check.kind === "accessibility" && check.id === id,
  );
  if (found === undefined) throw new Error(`no accessibility check called ${id}`);
  return found;
}

/** The same, for the kind that runs an audit rather than a sequence of steps. */
async function auditOutcomeOf(
  task: BenchTask,
  checkId: string,
  app: ScriptedBrowserSessionOptions,
): Promise<CheckOutcome> {
  const result = await runAccessibilityCheck(
    new ScriptedBrowserSession(app),
    auditNamed(task, checkId),
    { baseUrl: BASE_URL },
  );
  if (!result.ok) throw new Error(`the fake reported no browser: ${result.error.message}`);
  return result.value.outcome;
}

/** Runs one of a task's checks against a scripted application and reports what it concluded. */
async function outcomeOf(
  task: BenchTask,
  checkId: string,
  app: ScriptedBrowserSessionOptions,
): Promise<CheckOutcome> {
  const result = await runBrowserCheck(new ScriptedBrowserSession(app), checkNamed(task, checkId), {
    baseUrl: BASE_URL,
  });
  if (!result.ok) throw new Error(`the fake reported no browser: ${result.error.message}`);
  return result.value.outcome;
}

describe("landing-page", () => {
  const working: ScriptedBrowserSessionOptions = {
    pages: {
      "/": {
        elements: [
          { role: "heading", name: "Ship faster with Nap", text: "Ship faster with Nap" },
          { text: "Nap lets you describe your app and watch it appear." },
          { role: "button", name: "Get started" },
        ],
      },
    },
  };

  it("passes an application that has everything the prompt asked for", async () => {
    expect(await outcomeOf(LANDING_PAGE_TASK, "renders-the-page", working)).toBe("passed");
  });

  it("fails one whose heading says something else", async () => {
    const wrongHeading = {
      pages: {
        "/": {
          elements: [
            { role: "heading", name: "Welcome!", text: "Welcome!" },
            { text: "Nap lets you describe your app and watch it appear." },
            { role: "button", name: "Get started" },
          ],
        },
      },
    };

    expect(await outcomeOf(LANDING_PAGE_TASK, "renders-the-page", wrongHeading)).toBe("failed");
  });

  it("fails one with no call to action", async () => {
    const noButton = {
      pages: {
        "/": {
          elements: [
            { role: "heading", name: "Ship faster with Nap", text: "Ship faster with Nap" },
            { text: "Nap lets you describe your app and watch it appear." },
          ],
        },
      },
    };

    expect(await outcomeOf(LANDING_PAGE_TASK, "renders-the-page", noButton)).toBe("failed");
  });

  it("passes a page the audit is happy with and fails one it is not", async () => {
    // The check has to be able to go both ways or it is decorative. The violation is the one
    // a generated landing page really does ship: a control with no accessible name.
    expect(await auditOutcomeOf(LANDING_PAGE_TASK, "is-accessible", working)).toBe("passed");

    const inaccessible: ScriptedBrowserSessionOptions = {
      pages: {
        "/": {
          ...working.pages?.["/"],
          violations: [
            {
              id: "button-name",
              impact: "serious",
              help: "Buttons must have discernible text",
              helpUrl: "https://dequeuniversity.com/rules/axe/4.10/button-name",
              nodes: 1,
            },
          ],
        },
      },
    };

    expect(await auditOutcomeOf(LANDING_PAGE_TASK, "is-accessible", inaccessible)).toBe("failed");
  });

  it("does not fail the audit on a finding below the bar it set", async () => {
    // A benchmark check that fails every application ranks nothing. `serious` is the bar, so
    // a moderate finding is recorded in the trajectory and does not cost the run a category.
    const minorProblem: ScriptedBrowserSessionOptions = {
      pages: {
        "/": {
          ...working.pages?.["/"],
          violations: [
            {
              id: "region",
              impact: "moderate",
              help: "All page content should be contained by landmarks",
              helpUrl: "https://dequeuniversity.com/rules/axe/4.10/region",
              nodes: 2,
            },
          ],
        },
      },
    };

    expect(await auditOutcomeOf(LANDING_PAGE_TASK, "is-accessible", minorProblem)).toBe("passed");
  });

  it("passes a quiet page and fails one that threw, which nothing else here would notice", async () => {
    expect(await outcomeOf(LANDING_PAGE_TASK, "throws-nothing", working)).toBe("passed");
    expect(
      await outcomeOf(LANDING_PAGE_TASK, "throws-nothing", {
        ...working,
        consoleErrors: ["uncaught TypeError: undefined is not a function"],
      }),
    ).toBe("failed");
  });
});

/**
 * A to-do application, as the prompts describe one.
 *
 * `persists` is the only variable that matters, and it is what makes the regression testable: an
 * application that keeps its to-dos and one that merely appears to are indistinguishable until a
 * reload, and that is exactly the difference the follow-up prompt is capable of destroying.
 *
 * The typed-in text is tracked here rather than read back from the page because the controller
 * exposes no reader — which is honest, since a real component holds its input in state too.
 */
function todoApp(options: { persists: boolean; filters: boolean }): ScriptedBrowserSessionOptions {
  type Todo = { text: string; done: boolean };
  const todos: Todo[] = [];
  let filter: "All" | "Active" | "Completed" = "All";
  let typed = "";

  const shown = () =>
    todos.filter((todo) =>
      filter === "All" ? true : filter === "Completed" ? todo.done : !todo.done,
    );

  const controls: ScriptedElement[] = [
    { role: "textbox", label: "New todo", value: "" },
    { role: "button", name: "Add" },
    { role: "button", name: "Delete" },
    ...(options.filters
      ? (["All", "Active", "Completed"] as const).map((name) => ({ role: "button", name }))
      : []),
  ];

  return {
    pages: { "/": { elements: controls } },
    on: {
      fill: (interaction) => {
        typed = interaction.value ?? "";
      },
      click: ({ selector, page }) => {
        if (selector?.by !== "role") return;

        if (selector.role === "button" && selector.name === "Add") {
          if (typed !== "") todos.push({ text: typed, done: false });
          typed = "";
          // The stated requirement that adding clears the input, modelled as the application
          // would: the component owns the value and resets it.
          page.update({ by: "label", text: "New todo" }, { value: "" });
        } else if (selector.role === "checkbox" && selector.name !== undefined) {
          const todo = todos.find((candidate) => candidate.text === selector.name);
          if (todo !== undefined) todo.done = !todo.done;
        } else if (selector.role === "button" && selector.name === "Delete") {
          // One to-do at a time is all the check ever creates, which is what makes an
          // unqualified "Delete" unambiguous both here and on a real page.
          todos.pop();
        } else if (selector.role === "button" && isFilterName(selector.name)) {
          filter = selector.name;
        } else {
          return;
        }

        // Re-render, as a component would: clear what the list was and lay it out again from
        // state. Persisting or not is the whole experiment, so it is a parameter.
        page.remove({ by: "role", role: "listitem" });
        page.remove({ by: "role", role: "checkbox" });
        for (const todo of shown()) {
          page.add({ role: "listitem", text: todo.text }, { persists: options.persists });
          page.add({ role: "checkbox", name: todo.text }, { persists: options.persists });
        }
      },
    },
  };
}

const isFilterName = (name: string | undefined): name is "All" | "Active" | "Completed" =>
  name === "All" || name === "Active" || name === "Completed";

describe("todo-crud", () => {
  it("passes an application that adds a to-do and clears the input", async () => {
    expect(
      await outcomeOf(TODO_CRUD_TASK, "adds-a-todo", todoApp({ persists: true, filters: true })),
    ).toBe("passed");
  });

  it("passes an application that deletes a to-do, and fails one whose Delete does nothing", async () => {
    expect(
      await outcomeOf(TODO_CRUD_TASK, "deletes-a-todo", todoApp({ persists: true, filters: true })),
    ).toBe("passed");

    // A Delete button that renders and does nothing is the failure this catches — and the one
    // an agent is most likely to ship, since the button being there is the visible half.
    const inert: ScriptedBrowserSessionOptions = {
      ...todoApp({ persists: true, filters: true }),
      on: {
        fill: () => undefined,
        click: ({ selector, page }) => {
          if (selector?.by === "role" && selector.name === "Add") {
            page.add({ role: "listitem", text: "Buy milk" });
          }
        },
      },
    };

    expect(await outcomeOf(TODO_CRUD_TASK, "deletes-a-todo", inert)).toBe("failed");
  });

  it("passes one that saved its to-dos, and fails one that only looked like it did", async () => {
    // The reload is the whole assertion. Both applications behave identically until it happens.
    expect(
      await outcomeOf(
        TODO_CRUD_TASK,
        "survives-a-reload",
        todoApp({ persists: true, filters: true }),
      ),
    ).toBe("passed");
    expect(
      await outcomeOf(
        TODO_CRUD_TASK,
        "survives-a-reload",
        todoApp({ persists: false, filters: true }),
      ),
    ).toBe("failed");
  });

  it("passes an application whose filter changes what is visible", async () => {
    expect(
      await outcomeOf(
        TODO_CRUD_TASK,
        "filters-by-completion",
        todoApp({ persists: true, filters: true }),
      ),
    ).toBe("passed");
  });

  it("fails one where the follow-up was never done", async () => {
    expect(
      await outcomeOf(
        TODO_CRUD_TASK,
        "filters-by-completion",
        todoApp({ persists: true, filters: false }),
      ),
    ).toBe("failed");
  });

  it("catches the regression: the filter arrived and persistence went away", async () => {
    // The case the whole two-prompt task exists for. The follow-up was done correctly — the
    // filter check passes — and the first prompt's work was destroyed doing it. A single-prompt
    // task could not express this, and a task that stopped checking the first prompt after the
    // second would score this agent full marks.
    const regressed = () => todoApp({ persists: false, filters: true });

    expect(await outcomeOf(TODO_CRUD_TASK, "filters-by-completion", regressed())).toBe("passed");
    expect(await outcomeOf(TODO_CRUD_TASK, "survives-a-reload", regressed())).toBe("failed");
  });
});

describe("debug-broken", () => {
  const fixed: ScriptedBrowserSessionOptions = {
    pages: {
      "/": {
        elements: [
          { role: "heading", name: "Still to do", text: "Still to do" },
          { role: "listitem", text: "Build the prototype" },
          { role: "listitem", text: "Ship the release" },
        ],
      },
    },
  };

  it("passes an application where the bug was fixed", async () => {
    expect(await outcomeOf(DEBUG_BROKEN_TASK, "shows-the-unfinished-todos", fixed)).toBe("passed");
  });

  it("fails the seeded application, which renders an empty list", async () => {
    // The starting state. If this passed, the task would score every model full marks for
    // doing nothing at all — which is the failure mode a seeded task most invites.
    const stillBroken = {
      pages: {
        "/": { elements: [{ role: "heading", name: "Still to do", text: "Still to do" }] },
      },
    };

    expect(await outcomeOf(DEBUG_BROKEN_TASK, "shows-the-unfinished-todos", stillBroken)).toBe(
      "failed",
    );
  });

  it("fails an agent that 'fixed' it by showing every to-do", async () => {
    // Deleting the filter makes the list non-empty, which is the laziest passing-looking fix.
    const showsEverything = {
      pages: {
        "/": {
          elements: [
            { role: "heading", name: "Still to do", text: "Still to do" },
            { role: "listitem", text: "Write the specification" },
            { role: "listitem", text: "Build the prototype" },
            { role: "listitem", text: "Ship the release" },
          ],
        },
      },
    };

    expect(await outcomeOf(DEBUG_BROKEN_TASK, "shows-the-unfinished-todos", showsEverything)).toBe(
      "failed",
    );
  });

  it("fails an agent that shows two to-dos but the wrong two", async () => {
    // An off-by-one in the predicate gives the right *number* of items and the wrong ones.
    // Caught by the two `expectText` assertions rather than by the count — which is why the
    // check needs both, and why it needs no third assertion for the item it excludes.
    const wrongTwo = {
      pages: {
        "/": {
          elements: [
            { role: "heading", name: "Still to do", text: "Still to do" },
            { role: "listitem", text: "Write the specification" },
            { role: "listitem", text: "Build the prototype" },
          ],
        },
      },
    };

    expect(await outcomeOf(DEBUG_BROKEN_TASK, "shows-the-unfinished-todos", wrongTwo)).toBe(
      "failed",
    );
  });

  it("fails an agent that changed the heading it was told to leave alone", async () => {
    const renamed = {
      pages: {
        "/": {
          elements: [
            { role: "heading", name: "Todo list", text: "Todo list" },
            { role: "listitem", text: "Build the prototype" },
            { role: "listitem", text: "Ship the release" },
          ],
        },
      },
    };

    expect(await outcomeOf(DEBUG_BROKEN_TASK, "shows-the-unfinished-todos", renamed)).toBe(
      "failed",
    );
  });
});

describe("responsive-layout", () => {
  const LINKS: ScriptedElement[] = [
    { role: "link", name: "Home" },
    { role: "link", name: "Pricing" },
    { role: "link", name: "About" },
  ];

  /** A bar that collapses below 640px, which is what the prompt asked for. */
  /** The links present but hidden, plus the button that reveals them. */
  const COLLAPSED: ScriptedElement[] = [
    ...LINKS.map((link) => ({ ...link, visible: false })),
    { role: "button", name: "Menu" },
  ];

  const responsive: ScriptedBrowserSessionOptions = {
    pages: { "/": { elements: COLLAPSED } },
    on: {
      click: ({ selector, page }) => {
        if (selector?.by === "role" && selector.name === "Menu") {
          page.update({ by: "role", role: "link" }, { visible: true });
        }
      },
    },
  };

  /** A bar that renders one fixed desktop layout whatever the width. */
  const responsiveDesktop: ScriptedBrowserSessionOptions = {
    pages: { "/": { elements: LINKS } },
  };

  it("passes a desktop layout showing the links and no menu button", async () => {
    expect(
      await outcomeOf(RESPONSIVE_LAYOUT_TASK, "desktop-shows-the-links", responsiveDesktop),
    ).toBe("passed");
  });

  it("fails a desktop layout that still shows the menu button", async () => {
    const alwaysCollapsed = {
      pages: { "/": { elements: [...LINKS, { role: "button", name: "Menu" }] } },
    };

    expect(
      await outcomeOf(RESPONSIVE_LAYOUT_TASK, "desktop-shows-the-links", alwaysCollapsed),
    ).toBe("failed");
  });

  it("passes a mobile layout that hides the links until the menu is pressed", async () => {
    expect(await outcomeOf(RESPONSIVE_LAYOUT_TASK, "mobile-collapses-the-links", responsive)).toBe(
      "passed",
    );
  });

  it("fails a page that ignores the viewport entirely", async () => {
    // One fixed layout cannot satisfy both checks, which is the point of having two.
    expect(
      await outcomeOf(RESPONSIVE_LAYOUT_TASK, "mobile-collapses-the-links", responsiveDesktop),
    ).toBe("failed");
  });

  it("fails a mobile layout whose menu button does nothing", async () => {
    // The same elements, minus the handler that responds to them.
    const deadButton: ScriptedBrowserSessionOptions = { pages: { "/": { elements: COLLAPSED } } };

    expect(await outcomeOf(RESPONSIVE_LAYOUT_TASK, "mobile-collapses-the-links", deadButton)).toBe(
      "failed",
    );
  });

  it("fails a page that fits on desktop but spills over on mobile", async () => {
    // The objective half of "works on a phone", and the reason the check exists at all: this
    // page is otherwise correct at both sizes.
    const overflowing: ScriptedBrowserSessionOptions = {
      ...responsive,
      pages: { "/": { elements: COLLAPSED, scrollWidth: { mobile: 500, desktop: 1280 } } },
    };

    expect(await outcomeOf(RESPONSIVE_LAYOUT_TASK, "mobile-collapses-the-links", overflowing)).toBe(
      "failed",
    );
  });
});

describe("responsive-layout, audited at the size that differs", () => {
  it("passes a phone layout the audit is happy with, and fails an unnamed menu control", async () => {
    // The collapsed navigation is where this goes wrong in practice: a button holding the
    // links behind it, shipped with an icon and no accessible name. The desktop page passing
    // says nothing about this one, which is why the check declares a viewport.
    const clean: ScriptedBrowserSessionOptions = {
      pages: { "/": { elements: [{ role: "button", name: "Menu" }] } },
    };

    expect(await auditOutcomeOf(RESPONSIVE_LAYOUT_TASK, "is-accessible-on-a-phone", clean)).toBe(
      "passed",
    );

    const unnamedControl: ScriptedBrowserSessionOptions = {
      pages: {
        "/": {
          elements: [{ role: "button" }],
          violations: [
            {
              id: "button-name",
              impact: "critical",
              help: "Buttons must have discernible text",
              helpUrl: "https://dequeuniversity.com/rules/axe/4.10/button-name",
              nodes: 1,
            },
          ],
        },
      },
    };

    expect(
      await auditOutcomeOf(RESPONSIVE_LAYOUT_TASK, "is-accessible-on-a-phone", unnamedControl),
    ).toBe("failed");
  });
});

/**
 * A scripted expense ledger, and the ways of getting it subtly wrong.
 *
 * The larger half of proving `expense-ledger` discriminates: every check in that task asserts
 * two requirements *interacting*, so a fake that only implements them correctly cannot show
 * that any check would ever notice. Each defect below is one an agent could plausibly ship —
 * every one looks right on screen until a second rule is applied at the same time.
 */

type Expense = { name: string; amount: number; category: string };

/** Exactly what the prompt tells the agent to start with, in the order it states. */
const EXPENSES: readonly Expense[] = [
  { name: "Coffee", amount: 4, category: "Food" },
  { name: "Rent", amount: 1200, category: "Home" },
  { name: "Bus fare", amount: 3, category: "Travel" },
  { name: "Groceries", amount: 60, category: "Food" },
  { name: "Lamp", amount: 25, category: "Home" },
  { name: "Train", amount: 90, category: "Travel" },
];

const PAGE_SIZE = 3;

/**
 * The ways a plausible implementation goes wrong, each the result of applying one rule in the
 * wrong order relative to another.
 *
 * Named for what the application *does* rather than for the check it fails, because the point
 * is that each is a real mistake rather than a fixture built to fail an assertion.
 */
type LedgerDefects = {
  /** Counts the pages over every expense, so a filtered list still claims two pages. */
  paginatesBeforeFiltering?: boolean;
  /** Adds up what is on screen instead of the whole category, so paging changes the total. */
  totalsTheVisiblePage?: boolean;
  /** Sorts the three rows already rendered rather than the set they were taken from. */
  sortsOnlyTheVisiblePage?: boolean;
  /** Leaves the page index alone when the category changes, stranding the reader past the end. */
  keepsThePageWhenTheCategoryChanges?: boolean;
  /** Renders the sort button and never sorts — the half of a feature that is visible. */
  ignoresTheSortButton?: boolean;
};

type State = { category: string; sort: "none" | "asc" | "desc"; page: number };

/** What the application shows, given where it has been driven to. */
function view(state: State, defects: LedgerDefects): ScriptedElement[] {
  const matching = EXPENSES.filter(
    (expense) => state.category === "All" || expense.category === state.category,
  );

  // The correct order: sort the matching set, then take the page out of it. The defect takes
  // the page first and sorts what it got, which looks identical until the set is longer than
  // one page — which is exactly when a benchmark should notice.
  const ordered = defects.sortsOnlyTheVisiblePage
    ? sorted(matching.slice(offset(state), offset(state) + PAGE_SIZE), state.sort)
    : sorted(matching, state.sort).slice(offset(state), offset(state) + PAGE_SIZE);

  const pageCount = Math.max(
    1,
    Math.ceil((defects.paginatesBeforeFiltering ? EXPENSES.length : matching.length) / PAGE_SIZE),
  );

  const totalled = defects.totalsTheVisiblePage ? ordered : matching;
  const total = totalled.reduce((sum, expense) => sum + expense.amount, 0);

  return [
    ...ordered.map((expense) => ({ role: "listitem", text: expense.name })),
    { testId: "page", text: `Page ${state.page} of ${pageCount}` },
    { testId: "total", text: `Total: ${total}` },
  ];
}

function offset(state: State): number {
  return (state.page - 1) * PAGE_SIZE;
}

function sorted(expenses: readonly Expense[], order: State["sort"]): Expense[] {
  if (order === "none") return [...expenses];

  const ascending = [...expenses].sort((a, b) => a.amount - b.amount);
  return order === "asc" ? ascending : ascending.reverse();
}

/** The controls, which are on the page whatever state it is in. */
const CONTROLS: readonly ScriptedElement[] = [
  { role: "combobox", label: "Category", value: "All" },
  { role: "button", name: "Sort by amount" },
  { role: "button", name: "Previous" },
  { role: "button", name: "Next" },
];

/**
 * Replaces everything the state decides, leaving the controls where they are.
 *
 * `persists` is what the reload check turns on and off: an application that saved its state and
 * one that merely looked like it did behave identically until the page is reloaded.
 */
function rerender(
  page: ScriptedPageController,
  state: State,
  defects: LedgerDefects,
  persists: boolean,
): void {
  page.remove({ by: "role", role: "listitem" });
  page.remove({ by: "testId", id: "page" });
  page.remove({ by: "testId", id: "total" });

  for (const element of view(state, defects)) page.add(element, { persists });
}

function handlers(
  state: State,
  defects: LedgerDefects,
  persists: boolean,
): Partial<Record<ScriptedInteraction["action"], InteractionHandler>> {
  const pageCount = () => {
    const matching = EXPENSES.filter(
      (expense) => state.category === "All" || expense.category === state.category,
    );
    return Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  };

  return {
    click: ({ selector, page }: ScriptedInteraction) => {
      if (selector?.by !== "role") return;

      if (selector.name === "Sort by amount") {
        if (defects.ignoresTheSortButton) return;
        state.sort = state.sort === "asc" ? "desc" : "asc";
      } else if (selector.name === "Next") {
        state.page = Math.min(state.page + 1, pageCount());
      } else if (selector.name === "Previous") {
        state.page = Math.max(state.page - 1, 1);
      } else {
        return;
      }

      rerender(page, state, defects, persists);
    },
    select: ({ value, page }: ScriptedInteraction) => {
      if (value === undefined) return;

      state.category = value;
      // The rule that only exists because two others interact: page 2 of everything is not a
      // page of a filtered list, and an application that keeps the index shows an empty screen.
      if (!defects.keepsThePageWhenTheCategoryChanges) state.page = 1;

      rerender(page, state, defects, persists);
    },
  };
}

/**
 * An application that renders on load, for every check that asserts before interacting.
 *
 * Its declared page carries the opening render, because that is what a check like
 * "starts on the first page, unsorted" is about.
 */
function ledgerApp(defects: LedgerDefects = {}): ScriptedBrowserSessionOptions {
  const state: State = { category: "All", sort: "none", page: 1 };

  return {
    pages: { "/": { elements: [...CONTROLS, ...view(state, defects)] } },
    on: handlers(state, defects, false),
  };
}

/**
 * The same application, for the one check that reloads.
 *
 * **Its declared page is the controls alone**, and that is a limitation of the fake rather than
 * a claim about the application: a reload restores a page's *declared* elements plus whatever
 * was saved, so an application whose declared opening render is meant to be replaced by saved
 * state would come back showing both at once. Declaring nothing state-dependent is the only way
 * to model "what is on screen after a reload is what was saved". The check that uses this opens
 * by choosing a category, so the first render happens before anything is asserted.
 */
function savingLedger(options: {
  saves: boolean;
  defects?: LedgerDefects;
}): ScriptedBrowserSessionOptions {
  const state: State = { category: "All", sort: "none", page: 1 };

  return {
    pages: { "/": { elements: [...CONTROLS] } },
    on: handlers(state, options.defects ?? {}, options.saves),
  };
}

describe("expense-ledger", () => {
  it("passes an application that gets all five rules right", async () => {
    for (const checkId of [
      "starts-on-the-first-page-unsorted",
      "pages-forward-and-back",
      "filtering-repaginates-and-retotals",
      "sorting-changes-which-page-you-are-on",
      "filtering-and-sorting-hold-at-once",
      "changing-the-category-returns-to-page-one",
    ]) {
      expect(await outcomeOf(EXPENSE_LEDGER_TASK, checkId, ledgerApp())).toBe("passed");
    }
  });

  it("catches a page count taken before the filter was applied", async () => {
    // The list is right and the pager is not: two of six expenses are shown, under a legend
    // that still says there are two pages. Nothing about the visible rows is wrong.
    const app = ledgerApp({ paginatesBeforeFiltering: true });

    expect(await outcomeOf(EXPENSE_LEDGER_TASK, "filtering-repaginates-and-retotals", app)).toBe(
      "failed",
    );
  });

  it("catches a total that adds up the screen instead of the category", async () => {
    // Indistinguishable from correct whenever the matching set fits on one page — which is
    // most of the time, and is why a task without pagination could not find it at all. Two
    // Food expenses fit on one page, so the check that filters passes this application; the
    // one that pages does not.
    const app = ledgerApp({ totalsTheVisiblePage: true });

    expect(await outcomeOf(EXPENSE_LEDGER_TASK, "filtering-repaginates-and-retotals", app)).toBe(
      "passed",
    );
    expect(await outcomeOf(EXPENSE_LEDGER_TASK, "pages-forward-and-back", app)).toBe("failed");
  });

  it("catches a sort applied to the rows on screen rather than to the whole set", async () => {
    // The defect an ordering assertion would miss: the three visible rows really are in
    // ascending order. They are simply the wrong three.
    const app = ledgerApp({ sortsOnlyTheVisiblePage: true });

    expect(await outcomeOf(EXPENSE_LEDGER_TASK, "sorting-changes-which-page-you-are-on", app)).toBe(
      "failed",
    );
  });

  it("catches a page index that survives a change of category", async () => {
    const app = ledgerApp({ keepsThePageWhenTheCategoryChanges: true });

    expect(
      await outcomeOf(EXPENSE_LEDGER_TASK, "changing-the-category-returns-to-page-one", app),
    ).toBe("failed");
  });

  it("passes one that saved what it was showing, and fails one that only looked like it did", async () => {
    // Both applications behave identically until the reload, which is the whole assertion.
    //
    // **What the fake cannot show**, recorded rather than glossed: it persists whole elements,
    // so an application whose live view differs from its saved one — one that sorts on screen
    // and forgets on reload — is not expressible. What *is* expressible, and is asserted
    // below, is an application that never sorts at all; that is enough to make the
    // sort-sensitive assertions load-bearing rather than decorative.
    for (const checkId of ["remembers-the-category", "remembers-the-sort-and-the-page"]) {
      expect(await outcomeOf(EXPENSE_LEDGER_TASK, checkId, savingLedger({ saves: true }))).toBe(
        "passed",
      );
      expect(await outcomeOf(EXPENSE_LEDGER_TASK, checkId, savingLedger({ saves: false }))).toBe(
        "failed",
      );
    }
  });

  it("catches a reload that comes back unsorted", async () => {
    // Without this the sort half of the reload check is unproven: an application that saves
    // nothing already fails it on the page number alone, so the assertions about *which*
    // expenses came back could be deleted and no test would notice. This one pages and saves
    // correctly and never sorts, which leaves only those assertions to catch it.
    expect(
      await outcomeOf(
        EXPENSE_LEDGER_TASK,
        "remembers-the-sort-and-the-page",
        savingLedger({ saves: true, defects: { ignoresTheSortButton: true } }),
      ),
    ).toBe("failed");
  });

  it("catches a screen-total and a pre-filter page count on the checks that open the task", async () => {
    // The two checks that had only a passing case. A check never seen to fail is not known to
    // check anything, which is the rule this whole file exists to enforce.
    expect(
      await outcomeOf(
        EXPENSE_LEDGER_TASK,
        "starts-on-the-first-page-unsorted",
        ledgerApp({ totalsTheVisiblePage: true }),
      ),
    ).toBe("failed");

    expect(
      await outcomeOf(
        EXPENSE_LEDGER_TASK,
        "filtering-and-sorting-hold-at-once",
        ledgerApp({ paginatesBeforeFiltering: true }),
      ),
    ).toBe("failed");
  });

  it("passes a clean audit and fails one that ships an unlabelled control", async () => {
    expect(await auditOutcomeOf(EXPENSE_LEDGER_TASK, "is-accessible", ledgerApp())).toBe("passed");

    const unlabelled: ScriptedBrowserSessionOptions = {
      pages: {
        "/": {
          ...ledgerApp().pages?.["/"],
          violations: [
            {
              id: "select-name",
              impact: "serious",
              help: "Select element must have an accessible name",
              helpUrl: "https://dequeuniversity.com/rules/axe/4.10/select-name",
              nodes: 1,
            },
          ],
        },
      },
    };

    expect(await auditOutcomeOf(EXPENSE_LEDGER_TASK, "is-accessible", unlabelled)).toBe("failed");
  });
});
