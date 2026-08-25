import { describe, expect, it } from "vitest";
import {
  CAPTURE_VIEWPORTS,
  capturePlan,
  DEFAULT_SURFACE_ID,
  MAX_CAPTURES_PER_TASK,
  MAX_SURFACES_PER_TASK,
  surfacesOf,
} from "./surface.ts";
import { parseBenchTask } from "./task.ts";

/** A task whose only interesting field is whatever the case under test declares. */
function task(extras: Record<string, unknown> = {}) {
  const parsed = parseBenchTask({
    id: "todo",
    name: "A todo list",
    prompts: ["Build a todo list."],
    preview: { port: 5173 },
    checks: [{ id: "build", kind: "command", command: "bun run build" }],
    ...extras,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/**
 * A surface is only ever parsed as part of a task — which is the entry point these go through,
 * rather than a per-surface parser nobody hands one to.
 */
function parseSurfaceIn(surface: unknown) {
  return parseBenchTask({
    id: "todo",
    name: "A todo list",
    prompts: ["Build a todo list."],
    preview: { port: 5173 },
    surfaces: [surface],
    checks: [{ id: "build", kind: "command", command: "bun run build" }],
  });
}

describe("a declared surface", () => {
  it("accepts a name and the steps that reach it", () => {
    const parsed = parseSurfaceIn({
      id: "populated",
      steps: [
        { step: "fill", selector: { by: "label", text: "Task" }, value: "Buy milk" },
        { step: "press", key: "Enter" },
      ],
    });

    expect(parsed.ok).toBe(true);
  });

  it("accepts a surface with no steps at all — the front door as it loads", () => {
    expect(parseSurfaceIn({ id: "home" }).ok).toBe(true);
  });

  it("refuses an assertion among the steps", () => {
    // A capture pass has nowhere to put a failed assertion: a surface is evidence rather than
    // a check, so an assertion here would either be silently ignored or would fail a run over
    // something nobody scored.
    const parsed = parseSurfaceIn({
      id: "home",
      steps: [{ step: "expectText", text: "Todos" }],
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/assert/i);
  });

  it("refuses a resize among the steps", () => {
    // The pass photographs each surface at both sizes, so a surface that resized itself would
    // produce two images of one viewport and label one of them wrongly.
    const parsed = parseSurfaceIn({
      id: "home",
      steps: [{ step: "viewport", viewport: "tablet" }],
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/viewport/i);
  });

  it("refuses an id that could not be a filename", () => {
    expect(parseSurfaceIn({ id: "../escape" }).ok).toBe(false);
  });
});

describe("surfacesOf", () => {
  it("gives a task that declares none the front door", () => {
    expect(surfacesOf(task())).toEqual([{ id: DEFAULT_SURFACE_ID }]);
  });

  it("gives a task that declares surfaces exactly those", () => {
    const declared = task({
      surfaces: [{ id: "empty" }, { id: "populated", steps: [{ step: "navigate", path: "/all" }] }],
    });

    expect(surfacesOf(declared).map((surface) => surface.id)).toEqual(["empty", "populated"]);
  });
});

describe("capturePlan", () => {
  it("photographs every surface at both of the pair's viewports", () => {
    expect(capturePlan(task({ surfaces: [{ id: "empty" }] }))).toEqual([
      { surfaceId: "empty", viewport: "mobile", steps: [] },
      { surfaceId: "empty", viewport: "desktop", steps: [] },
    ]);
  });

  it("keeps a surface's two sizes adjacent, so a pair is never split", () => {
    const plan = capturePlan(task({ surfaces: [{ id: "a" }, { id: "b" }] }));

    expect(plan.map((entry) => `${entry.surfaceId}@${entry.viewport}`)).toEqual([
      "a@mobile",
      "a@desktop",
      "b@mobile",
      "b@desktop",
    ]);
  });

  it("plans the default pair for a task that declared nothing", () => {
    expect(capturePlan(task())).toEqual([
      { surfaceId: DEFAULT_SURFACE_ID, viewport: "mobile", steps: [] },
      { surfaceId: DEFAULT_SURFACE_ID, viewport: "desktop", steps: [] },
    ]);
  });

  it("carries each surface's steps into both of its entries", () => {
    const steps = [{ step: "navigate", path: "/settings" }];
    const plan = capturePlan(task({ surfaces: [{ id: "settings", steps }] }));

    expect(plan.map((entry) => entry.steps)).toEqual([steps, steps]);
  });
});

describe("the image budget", () => {
  it("is the pair per surface, and the ceiling is the pair times the surface ceiling", () => {
    expect(CAPTURE_VIEWPORTS).toEqual(["mobile", "desktop"]);
    expect(MAX_CAPTURES_PER_TASK).toBe(MAX_SURFACES_PER_TASK * CAPTURE_VIEWPORTS.length);
  });

  it("is two for a task that declares nothing", () => {
    expect(capturePlan(task())).toHaveLength(2);
  });

  it("cannot be exceeded, because the schema refuses more surfaces than the ceiling", () => {
    const surfaces = Array.from({ length: MAX_SURFACES_PER_TASK + 1 }, (_, index) => ({
      id: `surface-${index}`,
    }));

    const parsed = parseBenchTask({
      id: "todo",
      name: "A todo list",
      prompts: ["Build a todo list."],
      preview: { port: 5173 },
      surfaces,
      checks: [{ id: "build", kind: "command", command: "bun run build" }],
    });

    expect(parsed.ok).toBe(false);
  });

  it("is at most the ceiling for any task the schema accepts", () => {
    const surfaces = Array.from({ length: MAX_SURFACES_PER_TASK }, (_, index) => ({
      id: `surface-${index}`,
    }));

    expect(capturePlan(task({ surfaces }))).toHaveLength(MAX_CAPTURES_PER_TASK);
  });
});
