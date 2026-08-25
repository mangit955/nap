import { describe, expect, it } from "vitest";
import { categoryOf, flagsOf, parseBenchTask, weightOf } from "./task.ts";

const valid = {
  id: "landing-page",
  name: "A landing page",
  prompts: ["Build a landing page with a headline and a call to action."],
  checks: [{ id: "build", kind: "command", command: "bun run build" }],
};

describe("parseBenchTask", () => {
  it("accepts a well-formed task", () => {
    const parsed = parseBenchTask(valid);
    expect(parsed.ok).toBe(true);
    const check = parsed.ok ? parsed.value.checks[0] : undefined;
    if (check?.kind === "command") expect(check.command).toBe("bun run build");
  });

  it("rejects a task with no checks, which could never produce a score", () => {
    const parsed = parseBenchTask({ ...valid, checks: [] });
    expect(parsed.ok).toBe(false);
  });

  it("rejects an empty prompt", () => {
    expect(parseBenchTask({ ...valid, prompts: [""] }).ok).toBe(false);
  });

  it("rejects an unknown check kind rather than skipping it", () => {
    // A check nobody executes would silently not count towards the score, and the run
    // would look like it passed everything that was asked of it.
    const parsed = parseBenchTask({
      ...valid,
      checks: [{ id: "a11y", kind: "accessibility", command: "x" }],
    });
    expect(parsed.ok).toBe(false);
  });

  it("rejects an unknown field, so a mistyped key is not silently ignored", () => {
    // `weight` belongs on a check, not on the task. Accepted here it would read as a task
    // that is weighted against other tasks, which is not a thing.
    const parsed = parseBenchTask({ ...valid, weight: 3 });
    expect(parsed.ok).toBe(false);
  });

  it("accepts a check declaring its category, weight and whether it is required", () => {
    const parsed = parseBenchTask({
      ...valid,
      checks: [
        {
          id: "lint",
          kind: "command",
          command: "bun run lint",
          category: "code",
          weight: 2,
          required: true,
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const check = parsed.value.checks[0];
    if (check === undefined) throw new Error("the check vanished");
    expect(categoryOf(check)).toBe("code");
    expect(weightOf(check)).toBe(2);
    expect(check.required).toBe(true);
  });

  it("rejects a category that is not one of the four", () => {
    const parsed = parseBenchTask({
      ...valid,
      checks: [{ id: "a", kind: "command", command: "x", category: "performance" }],
    });
    expect(parsed.ok).toBe(false);
  });

  it("accepts a task declaring the application it expects to be serving", () => {
    const parsed = parseBenchTask({ ...valid, preview: { port: 5173, timeoutMs: 90_000 } });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.preview?.port).toBe(5173);
  });

  it("rejects a preview with no port, since there is nothing to probe without one", () => {
    expect(parseBenchTask({ ...valid, preview: {} }).ok).toBe(false);
    expect(parseBenchTask({ ...valid, preview: { port: 0 } }).ok).toBe(false);
    expect(parseBenchTask({ ...valid, preview: { url: "http://x" } }).ok).toBe(false);
  });

  it("accepts a check declaring itself the build", () => {
    const parsed = parseBenchTask({
      ...valid,
      checks: [{ id: "build", kind: "command", command: "bun run build", build: true }],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const check = parsed.value.checks[0];
    if (check === undefined) throw new Error("the check vanished");

    expect(flagsOf(check)).toEqual({ required: false, build: true });
  });

  it("rejects a negative weight, which would subtract from a category's score", () => {
    const parsed = parseBenchTask({
      ...valid,
      checks: [{ id: "a", kind: "command", command: "x", weight: -1 }],
    });
    expect(parsed.ok).toBe(false);
  });
});

describe("check defaults", () => {
  it("defaults a command to the functional category", () => {
    const parsed = parseBenchTask(valid);
    if (!parsed.ok) throw new Error(parsed.error);
    const check = parsed.value.checks[0];
    if (check === undefined) throw new Error("the check vanished");

    expect(check.category).toBeUndefined();
    expect(categoryOf(check)).toBe("functional");
  });

  it("defaults a weight to 1 and required to false", () => {
    const parsed = parseBenchTask(valid);
    if (!parsed.ok) throw new Error(parsed.error);
    const check = parsed.value.checks[0];
    if (check === undefined) throw new Error("the check vanished");

    expect(weightOf(check)).toBe(1);
    expect(flagsOf(check)).toEqual({ required: false, build: false });
  });

  it("leaves a deliberate zero weight alone rather than defaulting it", () => {
    // Zero is a real choice — a check somebody wants recorded but not scored — and `??`
    // rather than `||` is what keeps it from silently becoming 1.
    const parsed = parseBenchTask({
      ...valid,
      checks: [{ id: "a", kind: "command", command: "x", weight: 0 }],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const check = parsed.value.checks[0];
    if (check === undefined) throw new Error("the check vanished");

    expect(weightOf(check)).toBe(0);
  });

  it("rejects two checks sharing an id, which would make a result ambiguous", () => {
    const parsed = parseBenchTask({
      ...valid,
      checks: [
        { id: "build", kind: "command", command: "bun run build" },
        { id: "build", kind: "command", command: "bun run lint" },
      ],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("build");
  });

  it("explains what was wrong rather than failing bare", () => {
    const parsed = parseBenchTask({ ...valid, prompts: 42 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("prompt");
  });
});

describe("parseBenchTask — a task with browser checks", () => {
  const browserCheck = {
    id: "shows-the-list",
    kind: "browser",
    viewport: "mobile",
    steps: [{ step: "expectText", text: "Todos" }],
  };

  const withPreview = {
    id: "todo",
    name: "A todo list",
    prompts: ["Build a todo list."],
    preview: { port: 5173 },
    checks: [browserCheck],
  };

  it("accepts a browser check beside a command one", () => {
    const parsed = parseBenchTask({
      ...withPreview,
      checks: [{ id: "build", kind: "command", command: "bun run build" }, browserCheck],
    });

    expect(parsed.ok).toBe(true);
  });

  it("scores a browser check into the browser category by default", () => {
    const parsed = parseBenchTask(withPreview);
    if (!parsed.ok) throw new Error(parsed.error);
    const check = parsed.value.checks[0];
    if (check === undefined) throw new Error("the check vanished");

    expect(categoryOf(check)).toBe("browser");
    expect(flagsOf(check)).toEqual({ required: false, build: false });
  });

  it("lets a browser check score somewhere else, which is the ordinary case", () => {
    // "The to-do appears when the button is pressed" is functional; "nothing overflows at
    // 375px" is not. Both are browser checks.
    const parsed = parseBenchTask({
      ...withPreview,
      checks: [{ ...browserCheck, category: "functional" }],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const check = parsed.value.checks[0];
    if (check === undefined) throw new Error("the check vanished");

    expect(categoryOf(check)).toBe("functional");
  });

  it("rejects a browser check on a task with no preview to drive", () => {
    // The check could never be answered, and discovering that after a paid run would mean a
    // pile of failures that say nothing about the agent.
    const { preview, ...withoutPreview } = withPreview;
    const parsed = parseBenchTask(withoutPreview);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("preview");
  });

  it("rejects two checks of different kinds sharing an id", () => {
    const parsed = parseBenchTask({
      ...withPreview,
      checks: [{ id: "shows-the-list", kind: "command", command: "bun run build" }, browserCheck],
    });

    expect(parsed.ok).toBe(false);
  });
});

describe("parseBenchTask — a sequence of prompts", () => {
  it("accepts several, in the order the task wrote them", () => {
    const parsed = parseBenchTask({
      ...valid,
      prompts: ["Build a todo list.", "Now add a filter for completed items."],
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.prompts).toEqual([
        "Build a todo list.",
        "Now add a filter for completed items.",
      ]);
    }
  });

  it("rejects a task with no prompts, which would ask the agent for nothing", () => {
    expect(parseBenchTask({ ...valid, prompts: [] }).ok).toBe(false);
  });

  it("rejects a blank prompt among good ones, rather than sending whitespace as a turn", () => {
    expect(parseBenchTask({ ...valid, prompts: ["Build it.", "   "] }).ok).toBe(false);
  });
});

describe("parseBenchTask — seeded files", () => {
  const seeded = (files: unknown) => parseBenchTask({ ...valid, environment: { files } });

  it("accepts files to put in the sandbox before the agent runs", () => {
    const parsed = seeded([{ path: "src/App.tsx", contents: "export default function App() {}" }]);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.environment?.files).toHaveLength(1);
  });

  it("accepts an empty file, because a blank file is a legitimate starting state", () => {
    expect(seeded([{ path: "src/empty.ts", contents: "" }]).ok).toBe(true);
  });

  it("rejects an absolute path, which would write outside the project", () => {
    // Paths are relative to the project root and the runner joins them. An absolute one
    // would land wherever it said, which for `/etc/...` is not the application at all.
    expect(seeded([{ path: "/etc/passwd", contents: "x" }]).ok).toBe(false);
  });

  it("rejects a path that climbs out of the project", () => {
    expect(seeded([{ path: "../outside.ts", contents: "x" }]).ok).toBe(false);
    expect(seeded([{ path: "src/../../outside.ts", contents: "x" }]).ok).toBe(false);
  });

  it("rejects two files claiming the same path, where only one could survive", () => {
    expect(
      seeded([
        { path: "src/App.tsx", contents: "first" },
        { path: "src/App.tsx", contents: "second" },
      ]).ok,
    ).toBe(false);
  });

  it("rejects an environment declaring no files at all", () => {
    // Absent means "nothing to seed". An empty list means the same thing said a second way,
    // and two spellings of one state is a distinction somebody will eventually read into.
    expect(seeded([]).ok).toBe(false);
  });
});

describe("a task whose checks need the application to be serving", () => {
  const withoutPreview = (check: Record<string, unknown>) =>
    parseBenchTask({
      id: "landing-page",
      name: "A landing page",
      prompts: ["Build a landing page."],
      checks: [check],
    });

  it("is refused when it declares a browser check and no preview", () => {
    const parsed = withoutPreview({
      id: "shows-the-heading",
      kind: "browser",
      steps: [{ step: "expectText", text: "Hello" }],
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/preview/);
  });

  it("is refused when it declares an accessibility check and no preview", () => {
    // The same rule, and the reason it has to cover this kind too: an audit needs an address
    // to audit. Without this the task loads, the run records the audit as *failed* — "the
    // application was not serving" — and a permanent accusation against the agent is really
    // the task author having left a field out. Caught as the module loads, before a sandbox.
    const parsed = withoutPreview({ id: "is-accessible", kind: "accessibility" });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/preview/);
  });

  it("accepts a task whose only checks run inside the sandbox", () => {
    const parsed = withoutPreview({ id: "build", kind: "command", command: "bun run build" });

    expect(parsed.ok).toBe(true);
  });
});

describe("parseBenchTask — declared surfaces", () => {
  const withSurfaces = (surfaces: unknown) =>
    parseBenchTask({
      id: "todo",
      name: "A todo list",
      prompts: ["Build a todo list."],
      preview: { port: 5173 },
      surfaces,
      checks: [{ id: "build", kind: "command", command: "bun run build" }],
    });

  it("accepts named views with the steps that reach them", () => {
    const parsed = withSurfaces([
      { id: "empty" },
      {
        id: "populated",
        steps: [
          { step: "fill", selector: { by: "label", text: "Task" }, value: "Buy milk" },
          { step: "press", key: "Enter" },
        ],
      },
    ]);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.surfaces).toHaveLength(2);
  });

  it("rejects two surfaces sharing an id, which would collide on disk", () => {
    const parsed = withSurfaces([{ id: "home" }, { id: "home" }]);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/home/);
  });

  it("rejects an empty list, which says something different from declaring none", () => {
    expect(withSurfaces([]).ok).toBe(false);
  });

  it("rejects surfaces on a task with no preview to photograph", () => {
    // The same rule browser checks answer to: a surface is driven against the running
    // application, and one declared without a preview could never be reached.
    const parsed = parseBenchTask({
      id: "todo",
      name: "A todo list",
      prompts: ["Build a todo list."],
      surfaces: [{ id: "home" }],
      checks: [{ id: "build", kind: "command", command: "bun run build" }],
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/preview/);
  });
});

describe("parseBenchTask — the sentence a judge is shown", () => {
  const withIntent = (intent: unknown, extras: Record<string, unknown> = {}) =>
    parseBenchTask({
      id: "todo",
      name: "A todo list",
      prompts: ["Build a todo list."],
      preview: { port: 5173 },
      intent,
      ...extras,
      checks: [{ id: "build", kind: "command", command: "bun run build" }],
    });

  it("accepts one neutral sentence about what the application is for", () => {
    const parsed = withIntent("a place to keep track of what still needs doing");

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.intent).toMatch(/still needs doing/);
  });

  it("rejects an empty one, which tells a judge nothing", () => {
    expect(withIntent("   ").ok).toBe(false);
  });

  it("rejects a task with an intent and no preview, which could never be photographed", () => {
    // Judging is done from images, images come from surfaces, and a surface is driven against
    // the running application. A task declaring an intent it can never supply evidence for would
    // be scored on a product half of nothing, silently.
    const parsed = parseBenchTask({
      id: "todo",
      name: "A todo list",
      prompts: ["Build a todo list."],
      intent: "a place to keep track of what still needs doing",
      checks: [{ id: "build", kind: "command", command: "bun run build" }],
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/preview/);
  });
});
