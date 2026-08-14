import { describe, expect, it } from "vitest";
import { categoryOf, flagsOf, parseBenchTask, weightOf } from "./task.ts";

const valid = {
  id: "landing-page",
  name: "A landing page",
  prompt: "Build a landing page with a headline and a call to action.",
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
    expect(parseBenchTask({ ...valid, prompt: "" }).ok).toBe(false);
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
    const parsed = parseBenchTask({ ...valid, prompt: 42 });
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
    prompt: "Build a todo list.",
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
