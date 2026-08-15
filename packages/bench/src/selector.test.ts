/**
 * The selector value type: what it accepts, what it refuses, and how it reads back.
 *
 * Refusal is the interesting half. A selector is written by hand in a task file, and the
 * failure it invites is a field that looks right and is ignored — `{ by: "role", text: "Add" }`
 * would find every element with that role if the strict object let it through.
 */

import { describe, expect, it } from "vitest";
import { describeSelector, SelectorSchema } from "./selector.ts";

describe("SelectorSchema", () => {
  it("accepts all four ways of naming an element", () => {
    const selectors = [
      { by: "role", role: "button" },
      { by: "role", role: "button", name: "Add" },
      { by: "label", text: "New todo" },
      { by: "text", text: "Buy milk" },
      { by: "testId", id: "todo-list" },
    ];

    for (const selector of selectors) {
      expect(SelectorSchema.safeParse(selector).success).toBe(true);
    }
  });

  it("refuses a field belonging to a different kind of selector", () => {
    // The whole reason for the strict object: this would otherwise parse as "any button".
    expect(SelectorSchema.safeParse({ by: "role", role: "button", text: "Add" }).success).toBe(
      false,
    );
  });

  it("refuses an empty name, which would match everything rather than nothing", () => {
    expect(SelectorSchema.safeParse({ by: "text", text: "" }).success).toBe(false);
    expect(SelectorSchema.safeParse({ by: "testId", id: "" }).success).toBe(false);
  });

  it("refuses a kind of selector that does not exist", () => {
    expect(SelectorSchema.safeParse({ by: "css", value: ".btn" }).success).toBe(false);
  });
});

describe("describeSelector", () => {
  it("says what was looked for, including the accessible name when there is one", () => {
    expect(describeSelector({ by: "role", role: "button" })).toBe("role=button");
    expect(describeSelector({ by: "role", role: "button", name: "Add" })).toBe(
      'role=button named "Add"',
    );
    expect(describeSelector({ by: "label", text: "New todo" })).toBe('labelled "New todo"');
    expect(describeSelector({ by: "text", text: "Buy milk" })).toBe('text "Buy milk"');
    expect(describeSelector({ by: "testId", id: "list" })).toBe('test id "list"');
  });
});
