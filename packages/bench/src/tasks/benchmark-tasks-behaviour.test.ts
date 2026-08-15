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
  ScriptedBrowserSession,
  type ScriptedBrowserSessionOptions,
  type ScriptedElement,
} from "../testing/scripted-browser-session.ts";
import { DEBUG_BROKEN_TASK } from "./debug-broken.ts";
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
