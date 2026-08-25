/**
 * The four benchmark tasks, as data.
 *
 * `defineTask` already validates each one at import, so a malformed task fails before this file
 * runs — which means the interesting assertions here are not "does it parse" but the properties
 * that make the *set* a benchmark: every check objective, every asserted string quoted in a
 * prompt, and the specific shapes the spec asks each task for.
 */

import { describe, expect, it } from "vitest";
import type { BrowserCheck, BrowserStep } from "../browser-check.ts";
import { BENCH_TASKS, PRODUCT_SUITE, SUITES } from "../suite.ts";
import { type BenchTask, parseBenchTask } from "../task.ts";
import { DEBUG_BROKEN_TASK } from "./debug-broken.ts";
import { LANDING_PAGE_TASK } from "./landing-page.ts";
import { READING_LIST_TASK } from "./reading-list.ts";
import { RESPONSIVE_LAYOUT_TASK } from "./responsive-layout.ts";
import { TEMPLATE_PREVIEW_PORT } from "./template.ts";
import { TODO_CRUD_TASK } from "./todo-crud.ts";

const TASKS: BenchTask[] = [
  LANDING_PAGE_TASK,
  TODO_CRUD_TASK,
  DEBUG_BROKEN_TASK,
  RESPONSIVE_LAYOUT_TASK,
];

const browserChecks = (task: BenchTask): BrowserCheck[] =>
  task.checks.filter((check): check is BrowserCheck => check.kind === "browser");

/** Every string a step asserts on, so it can be checked against what the prompts asked for. */
function assertedStrings(step: BrowserStep): string[] {
  const strings: string[] = [];
  if ("text" in step && typeof step.text === "string") strings.push(step.text);
  if ("selector" in step && step.selector !== undefined) {
    const selector = step.selector;
    if (selector.by === "role" && selector.name !== undefined) strings.push(selector.name);
    if (selector.by === "label" || selector.by === "text") strings.push(selector.text);
  }
  return strings;
}

describe("the four benchmark tasks", () => {
  it("are four, and are the ones the specification names", () => {
    expect(TASKS.map((task) => task.id)).toEqual([
      "landing-page",
      "todo-crud",
      "debug-broken",
      "responsive-layout",
    ]);
  });

  it.each(TASKS.map((task) => [task.id, task] as const))("%s validates", (_id, task) => {
    // `defineTask` threw at import if this were false, so this is belt and braces — but it is
    // the assertion the ticket asks for, and a task reaching the schema by another route later
    // should still be covered.
    expect(parseBenchTask(task).ok).toBe(true);
  });

  it.each(TASKS.map((task) => [task.id, task] as const))(
    "%s has a unique id among the four",
    (id) => {
      expect(TASKS.filter((task) => task.id === id)).toHaveLength(1);
    },
  );

  it.each(TASKS.map((task) => [task.id, task] as const))(
    "%s declares a preview, because every one of them has something to look at",
    (_id, task) => {
      expect(task.preview?.port).toBe(TEMPLATE_PREVIEW_PORT);
    },
  );

  it.each(TASKS.map((task) => [task.id, task] as const))(
    "%s asserts only strings the agent was actually given",
    (_id, task) => {
      // The property that makes a check fair rather than a guess: every string a check expects
      // the *application* to produce was given to the agent, in those words. A task that drifts
      // — a check renamed without its prompt — fails here rather than measuring luck.
      //
      // Three sources count as "given", and the third is the subtle one. A check may type text
      // in and then assert the application echoed it: that string is the check's own data, not
      // something the agent was told, and demanding it appear in a prompt would force every
      // task to hard-code its test fixtures into the instructions.
      const given = [
        ...task.prompts,
        ...(task.environment?.files ?? []).map((file) => file.contents),
      ]
        .join("\n")
        .toLowerCase();

      for (const check of browserChecks(task)) {
        const typedIn = check.steps
          .filter((step) => step.step === "fill")
          .map((step) => step.value.toLowerCase());

        for (const step of check.steps) {
          for (const asserted of assertedStrings(step)) {
            const lowered = asserted.toLowerCase();
            if (typedIn.includes(lowered)) continue;

            expect(given, `"${asserted}" is asserted but was never given to the agent`).toContain(
              lowered,
            );
          }
        }
      }
    },
  );

  it.each(TASKS.map((task) => [task.id, task] as const))(
    "%s scores into the code category, so the four are on one scale",
    (_id, task) => {
      // Not an interest in any one task's tidiness: a task with no `code` check renormalises
      // its categories over a different set, and ADR-0002 has `compare` refuse two runs whose
      // effective weight vectors differ. One task missing this makes it incomparable.
      const code = task.checks.filter((check) => check.category === "code");
      expect(code.length).toBeGreaterThan(0);
    },
  );

  it.each(TASKS.map((task) => [task.id, task] as const))(
    "%s builds, and its build is the gate",
    (_id, task) => {
      const build = task.checks.filter((check) => check.kind === "command" && check.build === true);
      // Exactly one: two build checks would cap the run twice for one fact, and none would let
      // an application that does not compile score on its browser checks alone.
      expect(build).toHaveLength(1);
    },
  );
});

/**
 * The suite scored on both halves, and the properties that make it one.
 *
 * Asserted over the membership `suite.ts` declares rather than over a list written out again here,
 * so a task added to the suite has to satisfy these or fail — which is the point. Every rule below
 * is what separates a task described by *outcome* from the frozen four, which are described by
 * their interface and are fair for the opposite reason: they quote every string they assert.
 */
describe("the product suite — described by outcome, and judged as well as checked", () => {
  const PRODUCT_TASKS: BenchTask[] = SUITES[PRODUCT_SUITE].map((taskId) => {
    const task = BENCH_TASKS.find((candidate) => candidate.id === taskId);
    if (task === undefined) throw new Error(`the product suite names ${taskId}, which is missing`);
    return task;
  });

  const each = PRODUCT_TASKS.map((task) => [task.id, task] as const);

  const browserStrings = (task: BenchTask) =>
    browserChecks(task).flatMap((check) => check.steps.flatMap(assertedStrings));

  it("is three shapes rather than three subjects, which is what a suite has to be", () => {
    // A tool, a screen read at a glance, and a page written to persuade. Three variations on a
    // list would characterise a model once and report it three times.
    expect(PRODUCT_TASKS.map((task) => task.id)).toEqual([
      "reading-list",
      "sales-dashboard",
      "pricing-page",
    ]);
  });

  it.each(each)(
    "%s says what it is for, which is the whole of what a judge is shown",
    (_id, task) => {
      // No prompt, no checks, no specification: one neutral sentence, because that is what a
      // person opening the finished application has. See `product/evaluation.ts`.
      expect(task.intent).toBeDefined();
      for (const prompt of task.prompts) expect(task.intent).not.toContain(prompt);
    },
  );

  it.each(each)("%s declares the surfaces the judge is shown", (_id, task) => {
    // Declared rather than inferred: a judge's pair has to exist for a stated reason, and the
    // default pair is an intention rather than a decision. See `surface.ts`.
    expect(task.surfaces?.length ?? 0).toBeGreaterThan(0);
  });

  it.each(each)("%s asserts only behaviour and its own data", (_id, task) => {
    // The property that makes a task described by outcome fair, and the one that would be lost
    // first: the moment a check may assert a string because a *prompt* said it, the task is
    // measuring transcription again and the product half has nothing left to be about. So the
    // only strings a check may expect back are ones it typed in itself, or ones seeded into the
    // project as data — never wording the agent was merely told.
    const typedIn = browserChecks(task)
      .flatMap((check) => check.steps)
      .filter((step) => step.step === "fill")
      .map((step) => step.value);
    const seeded = (task.environment?.files ?? []).map((file) => file.contents).join("\n");

    for (const asserted of browserStrings(task)) {
      const supplied = typedIn.includes(asserted) || seeded.includes(asserted);
      expect(supplied, `"${asserted}" is asserted but was neither typed in nor seeded`).toBe(true);
    }
  });

  it.each(each)("%s names no wording, layout or component to guess at", (_id, task) => {
    // Selectors are the other way a task can quietly become a specification: a check clicking a
    // button *named* something is a check that decided what the button is called.
    const selectors = browserChecks(task)
      .flatMap((check) => check.steps)
      .flatMap((step) =>
        "selector" in step && step.selector !== undefined ? [step.selector] : [],
      );

    for (const selector of selectors) {
      expect(selector.by).toBe("role");
      expect(selector.by === "role" && selector.name).toBeUndefined();
    }
  });

  it.each(each)("%s is on the suite's one scale: a build gate and a code check", (_id, task) => {
    // The same reason the frozen four are held to this. A task with no `code` check
    // renormalises over a different set of categories, and its objective half — which is one
    // of the two things multiplied — would not mean what its neighbour's means.
    expect(
      task.checks.filter((check) => check.kind === "command" && check.build === true),
    ).toHaveLength(1);
    expect(task.checks.filter((check) => check.category === "code").length).toBeGreaterThan(0);
  });

  it.each(each)("%s is checked on a phone as well as looked at on one", (_id, task) => {
    // Every one of these prompts says the application is opened on a phone, and every one of
    // them is photographed at both sizes for `responsiveness`. Without this the small viewport
    // would be judged and never measured, and a judgement with no measurement beside it is the
    // arrangement ADR-0005 exists to avoid.
    const mobile = browserChecks(task).filter((check) => check.viewport === "mobile");
    expect(mobile.flatMap((check) => check.steps).map((step) => step.step)).toContain(
      "expectNoHorizontalOverflow",
    );
  });

  it("reading-list declares empty and populated, which is what a tool has to show", () => {
    // Both states, because an empty one is where a generated interface is most often
    // thoughtless and a populated one is the only one that says anything about density. The
    // two that are read rather than used have one surface each, and say so in their files.
    expect(READING_LIST_TASK.surfaces?.map((surface) => surface.id)).toEqual([
      "empty",
      "populated",
    ]);
  });

  it("keeps the seeded tasks' data out of their prompts, so the file is the source", () => {
    // A prompt that also listed the plans or the week's figures would be a second copy of the
    // data, and the two would drift — at which point the agent is told one thing and checked
    // against another.
    for (const task of PRODUCT_TASKS) {
      for (const file of task.environment?.files ?? []) {
        for (const prompt of task.prompts) expect(prompt).toContain(file.path);
        expect(task.prompts.join("\n")).not.toContain(file.contents);
      }
    }
  });
});

describe("todo-crud — the only task with a follow-up", () => {
  it("sends two prompts", () => {
    expect(TODO_CRUD_TASK.prompts).toHaveLength(2);
  });

  it("is the only one that does, so the sequence is a deliberate feature and not an accident", () => {
    const sequences = TASKS.filter((task) => task.prompts.length > 1);
    expect(sequences.map((task) => task.id)).toEqual(["todo-crud"]);
  });

  it("asks for the filter second, having asked for the list first", () => {
    expect(TODO_CRUD_TASK.prompts[0]?.toLowerCase()).toContain("to-do list");
    expect(TODO_CRUD_TASK.prompts[1]?.toLowerCase()).toContain("filter");
  });

  it("still checks the first prompt's behaviour, which is what catches a regression", () => {
    // These describe the list the *first* prompt asked for, and every check runs after the
    // second. An agent that adds the filter by rewriting the list fails them.
    const ids = browserChecks(TODO_CRUD_TASK).map((check) => check.id);
    expect(ids).toContain("adds-a-todo");
    expect(ids).toContain("survives-a-reload");
  });

  it("checks persistence with a reload rather than a navigation", () => {
    const survives = browserChecks(TODO_CRUD_TASK).find(
      (check) => check.id === "survives-a-reload",
    );
    expect(survives?.steps.map((step) => step.step)).toContain("reload");
  });

  it("asserts the filter changes what is visible, not merely that a button exists", () => {
    const filter = browserChecks(TODO_CRUD_TASK).find(
      (check) => check.id === "filters-by-completion",
    );
    const counts = filter?.steps.filter((step) => step.step === "expectCount") ?? [];

    // More than one, and not all the same: a filter that changed nothing would satisfy a
    // single count assertion.
    expect(counts.length).toBeGreaterThan(1);
    expect(new Set(counts.map((step) => step.count)).size).toBeGreaterThan(1);
  });
});

describe("debug-broken — the only task that seeds", () => {
  it("seeds source before the agent runs", () => {
    expect(DEBUG_BROKEN_TASK.environment?.files.map((file) => file.path)).toEqual([
      "src/todos.ts",
      "src/App.tsx",
    ]);
  });

  it("is the only one that seeds", () => {
    const seeding = TASKS.filter((task) => task.environment !== undefined);
    expect(seeding.map((task) => task.id)).toEqual(["debug-broken"]);
  });

  it("seeds source that actually contains the bug the prompt describes", () => {
    // The assignment-not-comparison. Pinned because the whole task is worthless if somebody
    // "tidies" this into `===` — it would seed a working application and measure nothing.
    const app = DEBUG_BROKEN_TASK.environment?.files.find((file) => file.path === "src/App.tsx");
    expect(app?.contents).toContain("todo.done = false");
    expect(app?.contents).not.toContain("todo.done === false");
  });

  it("seeds a heading and to-do wording the checks then hold it to", () => {
    const files = DEBUG_BROKEN_TASK.environment?.files ?? [];
    const source = files.map((file) => file.contents).join("\n");

    expect(source).toContain("Still to do");
    expect(source).toContain("Build the prototype");
    expect(source).toContain("Write the specification");
  });

  it("requires the fix, so a run that did not do the work cannot pass", () => {
    const fix = browserChecks(DEBUG_BROKEN_TASK).find(
      (check) => check.id === "shows-the-unfinished-todos",
    );
    expect(fix?.required).toBe(true);
  });
});

describe("responsive-layout — the only task asserted at two sizes", () => {
  it("checks more than one viewport", () => {
    const viewports = browserChecks(RESPONSIVE_LAYOUT_TASK).map((check) => check.viewport);
    expect(new Set(viewports)).toEqual(new Set(["mobile", "desktop"]));
  });

  it("asserts no horizontal overflow at every size it checks", () => {
    for (const check of browserChecks(RESPONSIVE_LAYOUT_TASK)) {
      expect(
        check.steps.some((step) => step.step === "expectNoHorizontalOverflow"),
        `${check.id} does not check for overflow`,
      ).toBe(true);
    }
  });

  it("requires the two sizes to differ, not merely to both render", () => {
    // The assertion that stops a fixed layout passing: desktop must find no menu button, and
    // mobile must find the links hidden until it is pressed.
    const desktop = browserChecks(RESPONSIVE_LAYOUT_TASK).find(
      (check) => check.viewport === "desktop",
    );
    const mobile = browserChecks(RESPONSIVE_LAYOUT_TASK).find(
      (check) => check.viewport === "mobile",
    );

    expect(desktop?.steps).toContainEqual(
      expect.objectContaining({ step: "expectCount", count: 0 }),
    );
    expect(mobile?.steps.map((step) => step.step)).toContain("click");
  });
});
