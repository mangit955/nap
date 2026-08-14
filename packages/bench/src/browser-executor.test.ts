/**
 * Every action and every assertion, against the scripted session — no browser anywhere.
 *
 * The assertions here are on what the executor *did* — the calls it made, in order — and on
 * the check result it produced, never on prose. The two cases each assertion needs are the
 * same two every time: the page satisfying it, and the page not, because an assertion that
 * has never been seen to fail is not known to assert anything.
 */

import { describe, expect, it } from "vitest";
import type { BrowserCheck, BrowserStep } from "./browser-check.ts";
import { runBrowserCheck } from "./browser-executor.ts";
import type { CheckResult } from "./report.ts";
import {
  ScriptedBrowserSession,
  type ScriptedBrowserSessionOptions,
} from "./testing/scripted-browser-session.ts";
import { VIEWPORT_SIZES } from "./viewport.ts";

const BASE_URL = "https://preview.example";

function check(steps: BrowserStep[], extras: Partial<BrowserCheck> = {}): BrowserCheck {
  return { id: "browser", kind: "browser", steps, ...extras };
}

async function run(
  steps: BrowserStep[],
  options: ScriptedBrowserSessionOptions = {},
  extras: Partial<BrowserCheck> = {},
): Promise<{ result: CheckResult; session: ScriptedBrowserSession }> {
  const session = new ScriptedBrowserSession(options);
  const outcome = await runBrowserCheck(session, check(steps, extras), { baseUrl: BASE_URL });
  if (!outcome.ok) throw new Error(`the driver failed: ${outcome.error.message}`);
  return { result: outcome.value, session };
}

/** Shorthand for the common case: did this sequence pass, against this page? */
async function outcomeOf(
  steps: BrowserStep[],
  options: ScriptedBrowserSessionOptions = {},
  extras: Partial<BrowserCheck> = {},
): Promise<CheckResult["outcome"]> {
  return (await run(steps, options, extras)).result.outcome;
}

const heading: ScriptedBrowserSessionOptions = {
  pages: {
    "/": {
      elements: [
        { role: "heading", name: "Todos", text: "Todos" },
        { role: "textbox", label: "New todo", value: "" },
        { role: "button", name: "Add" },
      ],
    },
  },
};

describe("runBrowserCheck", () => {
  describe("the sequence itself", () => {
    it("sets the viewport and opens the application before the first step", async () => {
      const { session } = await run([{ step: "expectText", text: "Todos" }], heading);

      expect(session.calls.slice(0, 2)).toEqual([
        { method: "setViewport", viewport: VIEWPORT_SIZES.desktop },
        { method: "goto", url: BASE_URL, timeoutMs: undefined },
      ]);
    });

    it("runs at the viewport the check declared", async () => {
      const { session } = await run([{ step: "expectText", text: "Todos" }], heading, {
        viewport: "mobile",
      });

      expect(session.calls[0]).toEqual({
        method: "setViewport",
        viewport: VIEWPORT_SIZES.mobile,
      });
    });

    it("stops at the first failing step and says which one it was", async () => {
      const { result, session } = await run(
        [
          { step: "expectText", text: "Todos" },
          { step: "expectText", text: "Nothing here says this" },
          { step: "click", selector: { by: "role", role: "button", name: "Add" } },
        ],
        heading,
      );

      expect(result.outcome).toBe("failed");
      expect(result.detail).toContain("step 2");
      expect(result.detail).toContain("expectText");
      // The step after the failure must not have run: a sequence continued past a broken
      // assertion is measuring a page that is already not the one the check described.
      expect(session.calls.some((call) => call.method === "click")).toBe(false);
    });

    it("reports what a passing check actually did", async () => {
      const { result } = await run(
        [
          { step: "expectText", text: "Todos" },
          { step: "click", selector: { by: "role", role: "button", name: "Add" } },
        ],
        heading,
      );

      expect(result).toEqual({
        checkId: "browser",
        kind: "browser",
        category: "browser",
        weight: 1,
        required: false,
        build: false,
        outcome: "passed",
        detail: "2 steps passed at desktop",
      });
    });

    it("carries the category, weight and required flag the check declared", async () => {
      const { result } = await run([{ step: "expectText", text: "Todos" }], heading, {
        category: "functional",
        weight: 3,
        required: true,
      });

      expect(result).toMatchObject({ category: "functional", weight: 3, required: true });
    });

    it("hands back a driver that has gone away, rather than blaming the application", async () => {
      // The distinction the whole benchmark rests on: no browser is our fault, and recording
      // it as a failed check would charge it to the agent.
      const session = new ScriptedBrowserSession({
        fail: (call) =>
          call.method === "goto" ? { code: "unavailable", message: "no browser" } : undefined,
      });

      const outcome = await runBrowserCheck(session, check([{ step: "reload" }]), {
        baseUrl: BASE_URL,
      });

      expect(outcome).toEqual({ ok: false, error: { code: "unavailable", message: "no browser" } });
    });

    it("fails the check when the application will not load", async () => {
      const session = new ScriptedBrowserSession({
        fail: (call) =>
          call.method === "goto"
            ? { code: "navigation_failed", message: "connection refused" }
            : undefined,
      });

      const outcome = await runBrowserCheck(session, check([{ step: "reload" }]), {
        baseUrl: BASE_URL,
      });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.value.outcome).toBe("failed");
    });

    it("passes each step's own timeout through, falling back to the check's", async () => {
      const { session } = await run(
        [
          { step: "expectVisible", selector: { by: "testId", id: "a" }, timeoutMs: 250 },
          { step: "expectVisible", selector: { by: "testId", id: "a" } },
        ],
        { pages: { "/": { elements: [{ testId: "a" }] } } },
        { timeoutMs: 9000 },
      );

      const waits = session.calls.filter((call) => call.method === "isVisible");
      expect(waits.map((call) => call.timeoutMs)).toEqual([250, 9000]);
    });
  });

  describe("actions", () => {
    it("navigates to a path relative to the application", async () => {
      const { result, session } = await run(
        [
          { step: "navigate", path: "/about" },
          { step: "expectUrl", equals: "/about" },
        ],
        { pages: { "/": {}, "/about": {} } },
      );

      expect(result.outcome).toBe("passed");
      expect(session.calls.filter((call) => call.method === "goto").at(-1)).toMatchObject({
        url: `${BASE_URL}/about`,
      });
    });

    it("fails the check when navigation goes nowhere", async () => {
      expect(
        await outcomeOf([{ step: "navigate", path: "/missing" }], { pages: { "/": {} } }),
      ).toBe("failed");
    });

    it("clicks an element, and lets the application react", async () => {
      const outcome = await outcomeOf(
        [
          { step: "click", selector: { by: "role", role: "button", name: "Add" } },
          { step: "expectText", text: "Buy milk" },
        ],
        {
          ...heading,
          on: { click: ({ page }) => page.add({ text: "Buy milk", role: "listitem" }) },
        },
      );

      expect(outcome).toBe("passed");
    });

    it("fails the check when there is nothing to click", async () => {
      expect(
        await outcomeOf([{ step: "click", selector: { by: "testId", id: "nope" } }], heading),
      ).toBe("failed");
    });

    it("fills an input, which changes its value", async () => {
      const outcome = await outcomeOf(
        [
          { step: "fill", selector: { by: "label", text: "New todo" }, value: "Buy milk" },
          {
            step: "expectInputValue",
            selector: { by: "label", text: "New todo" },
            equals: "Buy milk",
          },
        ],
        heading,
      );

      expect(outcome).toBe("passed");
    });

    it("presses a key on an element, and on the page when no element is named", async () => {
      const pressed: (string | undefined)[] = [];
      const { result, session } = await run(
        [
          { step: "press", key: "Enter", selector: { by: "label", text: "New todo" } },
          { step: "press", key: "Escape" },
        ],
        {
          ...heading,
          on: {
            press: ({ key, selector }) => {
              pressed.push(`${key}:${selector === undefined ? "page" : selector.by}`);
            },
          },
        },
      );

      expect(result.outcome).toBe("passed");
      expect(pressed).toEqual(["Enter:label", "Escape:page"]);
      expect(session.calls.filter((call) => call.method === "press")).toHaveLength(2);
    });

    it("reloads, and unsaved state does not survive it", async () => {
      const unsaved = await outcomeOf(
        [
          { step: "click", selector: { by: "role", role: "button", name: "Add" } },
          { step: "expectText", text: "Buy milk" },
          { step: "reload" },
          { step: "expectText", text: "Buy milk" },
        ],
        { ...heading, on: { click: ({ page }) => page.add({ text: "Buy milk" }) } },
      );

      expect(unsaved).toBe("failed");
    });

    it("selects an option", async () => {
      const outcome = await outcomeOf(
        [
          { step: "select", selector: { by: "label", text: "Filter" }, value: "completed" },
          { step: "expectCount", selector: { by: "role", role: "listitem" }, count: 1 },
        ],
        {
          pages: {
            "/": {
              elements: [
                { label: "Filter", role: "combobox", value: "all" },
                { role: "listitem", text: "Buy milk", testId: "open" },
                { role: "listitem", text: "Walk dog", testId: "done" },
              ],
            },
          },
          on: {
            select: ({ value, page }) => {
              if (value === "completed") page.remove({ by: "testId", id: "open" });
            },
          },
        },
      );

      expect(outcome).toBe("passed");
    });

    it("changes the viewport part-way through a check", async () => {
      const { result, session } = await run(
        [
          { step: "expectNoHorizontalOverflow" },
          { step: "viewport", viewport: "mobile" },
          { step: "expectNoHorizontalOverflow" },
        ],
        { pages: { "/": { scrollWidth: { mobile: 500 } } } },
      );

      expect(result.outcome).toBe("failed");
      expect(result.detail).toContain("step 3");
      expect(session.calls.filter((call) => call.method === "setViewport")).toEqual([
        { method: "setViewport", viewport: VIEWPORT_SIZES.desktop },
        { method: "setViewport", viewport: VIEWPORT_SIZES.mobile },
      ]);
    });
  });

  describe("assertions", () => {
    it("expectText passes on visible text and fails on hidden text", async () => {
      const page = (visible: boolean): ScriptedBrowserSessionOptions => ({
        pages: { "/": { elements: [{ text: "Buy milk", visible }] } },
      });

      expect(await outcomeOf([{ step: "expectText", text: "Buy milk" }], page(true))).toBe(
        "passed",
      );
      expect(await outcomeOf([{ step: "expectText", text: "Buy milk" }], page(false))).toBe(
        "failed",
      );
    });

    it("expectNoText is the other way round", async () => {
      expect(await outcomeOf([{ step: "expectNoText", text: "Buy milk" }], heading)).toBe("passed");
      expect(await outcomeOf([{ step: "expectNoText", text: "Todos" }], heading)).toBe("failed");
    });

    it("expectVisible finds an element by every kind of selector", async () => {
      const selectors = [
        { by: "role", role: "button", name: "Add" },
        { by: "label", text: "New todo" },
        { by: "text", text: "Todo" },
        { by: "testId", id: "root" },
      ] as const;

      for (const selector of selectors) {
        expect(
          await outcomeOf([{ step: "expectVisible", selector }], {
            pages: {
              "/": { elements: [...(heading.pages?.["/"]?.elements ?? []), { testId: "root" }] },
            },
          }),
        ).toBe("passed");
      }
    });

    it("expectVisible fails when nothing matches", async () => {
      expect(
        await outcomeOf(
          [{ step: "expectVisible", selector: { by: "testId", id: "nope" } }],
          heading,
        ),
      ).toBe("failed");
    });

    it("expectCount counts visible matches, and says both numbers when it fails", async () => {
      const page: ScriptedBrowserSessionOptions = {
        pages: {
          "/": {
            elements: [
              { role: "listitem", text: "one" },
              { role: "listitem", text: "two" },
              { role: "listitem", text: "hidden", visible: false },
            ],
          },
        },
      };
      const counting = (count: number): BrowserStep => ({
        step: "expectCount",
        selector: { by: "role", role: "listitem" },
        count,
      });

      expect(await outcomeOf([counting(2)], page)).toBe("passed");

      const { result } = await run([counting(3)], page);
      expect(result.outcome).toBe("failed");
      expect(result.detail).toContain("3");
      expect(result.detail).toContain("2");
    });

    it("expectUrl compares the path, not the address the sandbox happened to get", async () => {
      const pages = { "/": {}, "/about": {} };

      expect(
        await outcomeOf(
          [
            { step: "navigate", path: "/about" },
            { step: "expectUrl", equals: "/about" },
          ],
          {
            pages,
          },
        ),
      ).toBe("passed");
      expect(await outcomeOf([{ step: "expectUrl", equals: "/about" }], { pages })).toBe("failed");
    });

    it("expectUrlContains matches part of it", async () => {
      const pages = { "/": {}, "/todos": {} };

      expect(
        await outcomeOf(
          [
            { step: "navigate", path: "/todos?filter=completed" },
            { step: "expectUrlContains", text: "filter=completed" },
          ],
          { pages },
        ),
      ).toBe("passed");
      expect(
        await outcomeOf(
          [
            { step: "navigate", path: "/todos" },
            { step: "expectUrlContains", text: "filter=completed" },
          ],
          { pages },
        ),
      ).toBe("failed");
    });

    it("expectAttribute reads an attribute, and null asserts its absence", async () => {
      const page: ScriptedBrowserSessionOptions = {
        pages: {
          "/": {
            elements: [{ testId: "submit", role: "button", attributes: { disabled: "true" } }],
          },
        },
      };
      const attribute = (name: string, equals: string | null): BrowserStep => ({
        step: "expectAttribute",
        selector: { by: "testId", id: "submit" },
        name,
        equals,
      });

      expect(await outcomeOf([attribute("disabled", "true")], page)).toBe("passed");
      expect(await outcomeOf([attribute("disabled", "false")], page)).toBe("failed");
      expect(await outcomeOf([attribute("aria-hidden", null)], page)).toBe("passed");
      expect(await outcomeOf([attribute("disabled", null)], page)).toBe("failed");
    });

    it("expectAttribute fails when the element is not there at all", async () => {
      expect(
        await outcomeOf(
          [
            {
              step: "expectAttribute",
              selector: { by: "testId", id: "nope" },
              name: "disabled",
              equals: null,
            },
          ],
          heading,
        ),
      ).toBe("failed");
    });

    it("expectInputValue reads the live value rather than the markup", async () => {
      const filling: BrowserStep = {
        step: "fill",
        selector: { by: "label", text: "New todo" },
        value: "Buy milk",
      };
      const expecting = (equals: string): BrowserStep => ({
        step: "expectInputValue",
        selector: { by: "label", text: "New todo" },
        equals,
      });

      expect(await outcomeOf([expecting("")], heading)).toBe("passed");
      expect(await outcomeOf([filling, expecting("Buy milk")], heading)).toBe("passed");
      expect(await outcomeOf([filling, expecting("")], heading)).toBe("failed");
    });

    it("expectNoHorizontalOverflow passes on a page that fits and fails on one that spills", async () => {
      const spilling: ScriptedBrowserSessionOptions = {
        pages: { "/": { scrollWidth: 420 } },
      };

      expect(
        await outcomeOf([{ step: "expectNoHorizontalOverflow" }], spilling, {
          viewport: "desktop",
        }),
      ).toBe("passed");
      expect(
        await outcomeOf([{ step: "expectNoHorizontalOverflow" }], spilling, { viewport: "mobile" }),
      ).toBe("failed");
    });

    it("expectNoHorizontalOverflow forgives sub-pixel rounding, and only that", async () => {
      const by = (overshoot: number): ScriptedBrowserSessionOptions => ({
        pages: { "/": { scrollWidth: VIEWPORT_SIZES.mobile.width + overshoot } },
      });

      expect(
        await outcomeOf([{ step: "expectNoHorizontalOverflow" }], by(1), { viewport: "mobile" }),
      ).toBe("passed");
      expect(
        await outcomeOf([{ step: "expectNoHorizontalOverflow" }], by(2), { viewport: "mobile" }),
      ).toBe("failed");
      expect(
        await outcomeOf([{ step: "expectNoHorizontalOverflow", tolerancePx: 8 }], by(2), {
          viewport: "mobile",
        }),
      ).toBe("passed");
    });
  });

  describe("state surviving a reload", () => {
    // The point of the whole port: a persistence claim is checkable, and an application that
    // only *looks* like it saved something is caught.
    const adding: BrowserStep[] = [
      { step: "fill", selector: { by: "label", text: "New todo" }, value: "Buy milk" },
      { step: "click", selector: { by: "role", role: "button", name: "Add" } },
      { step: "expectText", text: "Buy milk" },
      { step: "reload" },
      { step: "expectText", text: "Buy milk" },
    ];

    it("passes when the application saved what it was given", async () => {
      const outcome = await outcomeOf(adding, {
        ...heading,
        on: { click: ({ page }) => page.add({ text: "Buy milk" }, { persists: true }) },
      });

      expect(outcome).toBe("passed");
    });

    it("fails when it only appeared to", async () => {
      const outcome = await outcomeOf(adding, {
        ...heading,
        on: { click: ({ page }) => page.add({ text: "Buy milk" }) },
      });

      expect(outcome).toBe("failed");
    });
  });
});
