/**
 * What a browser check may say, and — mostly — what it may not.
 *
 * A step is data, so every mistake available in a task file is a shape mistake: a step nobody
 * executes, a field on the wrong step, a path that is not one. All of them have to be caught as
 * the module loads, because the alternative is a check that quietly asserts nothing and a run
 * that looks like it passed everything asked of it.
 */

import { describe, expect, it } from "vitest";
import { BrowserCheckSchema, BrowserStepSchema, isAssertion } from "./browser-check.ts";

function step(input: unknown): boolean {
  return BrowserStepSchema.safeParse(input).success;
}

const SELECTOR = { by: "testId", id: "add" } as const;

describe("BrowserStepSchema", () => {
  it("accepts every action", () => {
    expect(step({ step: "navigate", path: "/about" })).toBe(true);
    expect(step({ step: "click", selector: SELECTOR })).toBe(true);
    expect(step({ step: "fill", selector: SELECTOR, value: "Buy milk" })).toBe(true);
    expect(step({ step: "press", key: "Enter" })).toBe(true);
    expect(step({ step: "press", key: "Enter", selector: SELECTOR })).toBe(true);
    expect(step({ step: "reload" })).toBe(true);
    expect(step({ step: "select", selector: SELECTOR, value: "completed" })).toBe(true);
    expect(step({ step: "viewport", viewport: "mobile" })).toBe(true);
  });

  it("accepts every assertion", () => {
    expect(step({ step: "expectText", text: "Buy milk" })).toBe(true);
    expect(step({ step: "expectNoText", text: "Buy milk" })).toBe(true);
    expect(step({ step: "expectVisible", selector: SELECTOR })).toBe(true);
    expect(step({ step: "expectCount", selector: SELECTOR, count: 0 })).toBe(true);
    expect(step({ step: "expectUrl", equals: "/todos" })).toBe(true);
    expect(step({ step: "expectUrlContains", text: "filter=done" })).toBe(true);
    expect(step({ step: "expectAttribute", selector: SELECTOR, name: "href", equals: "/a" })).toBe(
      true,
    );
    expect(step({ step: "expectAttribute", selector: SELECTOR, name: "href", equals: null })).toBe(
      true,
    );
    expect(step({ step: "expectInputValue", selector: SELECTOR, equals: "" })).toBe(true);
    expect(step({ step: "expectNoHorizontalOverflow" })).toBe(true);
    expect(step({ step: "expectNoHorizontalOverflow", tolerancePx: 4 })).toBe(true);
  });

  it("refuses a step nobody executes", () => {
    expect(step({ step: "hover", selector: SELECTOR })).toBe(false);
  });

  it("refuses a field the step does not have", () => {
    // `expectVisible` with a `text` field reads like an assertion about text and is not one.
    expect(step({ step: "expectVisible", selector: SELECTOR, text: "Buy milk" })).toBe(false);
  });

  it("refuses an absolute URL where a path belongs", () => {
    // The host belongs to whichever sandbox this run got, so a task cannot know it.
    expect(step({ step: "navigate", path: "https://example.com/about" })).toBe(false);
    expect(step({ step: "expectUrl", equals: "todos" })).toBe(false);
  });

  it("refuses a negative count and a fractional timeout", () => {
    expect(step({ step: "expectCount", selector: SELECTOR, count: -1 })).toBe(false);
    expect(step({ step: "click", selector: SELECTOR, timeoutMs: 1.5 })).toBe(false);
  });
});

describe("BrowserCheckSchema", () => {
  const valid = {
    id: "adds-a-todo",
    kind: "browser",
    steps: [{ step: "expectText", text: "Todos" }],
  };

  it("accepts a check with no viewport, which means desktop", () => {
    const parsed = BrowserCheckSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.viewport).toBeUndefined();
  });

  it("accepts a named viewport and refuses an invented one", () => {
    expect(BrowserCheckSchema.safeParse({ ...valid, viewport: "mobile" }).success).toBe(true);
    expect(BrowserCheckSchema.safeParse({ ...valid, viewport: "watch" }).success).toBe(false);
  });

  it("refuses a check with no steps, which would always pass", () => {
    expect(BrowserCheckSchema.safeParse({ ...valid, steps: [] }).success).toBe(false);
  });

  it("refuses the build flag, which is a command's business", () => {
    // A browser check cannot be the thing that decides an application compiles: it needs the
    // application to have compiled before it can be run at all.
    expect(BrowserCheckSchema.safeParse({ ...valid, build: true }).success).toBe(false);
  });
});

describe("isAssertion", () => {
  it("tells the two halves of the union apart", () => {
    expect(isAssertion({ step: "click", selector: SELECTOR })).toBe(false);
    expect(isAssertion({ step: "expectText", text: "Todos" })).toBe(true);
  });
});
