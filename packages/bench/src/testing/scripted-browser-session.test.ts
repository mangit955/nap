/**
 * The fake's own contract, tested directly rather than through the executor.
 *
 * Every browser assertion in the benchmark is only as trustworthy as this file: if the fake
 * answers `isVisible` wrongly, a hundred executor tests agree with it and all of them are
 * green. So the browser behaviours it models — visibility, matching, what a reload throws
 * away — are pinned here, where a mistake in them has nowhere to hide.
 */

import { describe, expect, it } from "vitest";
import { VIEWPORT_SIZES } from "../viewport.ts";
import { ScriptedBrowserSession } from "./scripted-browser-session.ts";

const ELEMENTS = [
  { role: "button", name: "Add", testId: "add" },
  { role: "textbox", label: "New todo", value: "" },
  { text: "Nothing to do yet" },
  { role: "listitem", text: "Hidden item", visible: false },
];

function session(overrides: ConstructorParameters<typeof ScriptedBrowserSession>[0] = {}) {
  return new ScriptedBrowserSession({ pages: { "/": { elements: ELEMENTS } }, ...overrides });
}

async function value<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
): Promise<T> {
  if (!result.ok) throw new Error(`expected an answer, got ${JSON.stringify(result.error)}`);
  return result.value;
}

describe("matching", () => {
  it("finds elements by role, by role and name, by label, by text and by test id", async () => {
    const page = session();

    expect(await value(await page.isVisible({ by: "role", role: "button" }))).toBe(true);
    expect(await value(await page.isVisible({ by: "role", role: "button", name: "Add" }))).toBe(
      true,
    );
    expect(await value(await page.isVisible({ by: "role", role: "button", name: "Nope" }))).toBe(
      false,
    );
    expect(await value(await page.isVisible({ by: "label", text: "New todo" }))).toBe(true);
    expect(await value(await page.isVisible({ by: "testId", id: "add" }))).toBe(true);
  });

  it("matches text as a substring, the way a real text selector does", async () => {
    const page = session();

    expect(await value(await page.isVisible({ by: "text", text: "Nothing to do" }))).toBe(true);
  });

  it("does not count an element that is present but hidden", async () => {
    const page = session();

    expect(await value(await page.isVisible({ by: "role", role: "listitem" }))).toBe(false);
    expect(await value(await page.count({ by: "role", role: "listitem" }))).toBe(0);
  });
});

describe("interaction", () => {
  it("refuses to click something that is not there", async () => {
    const page = session();

    const clicked = await page.click({ by: "testId", id: "missing" });

    expect(clicked.ok).toBe(false);
    if (!clicked.ok) expect(clicked.error.code).toBe("not_found");
  });

  it("sets an input's value before the application hears about it", async () => {
    // A browser does this itself; an application that ignores the event still has the value.
    const page = session();

    await page.fill({ by: "label", text: "New todo" }, "Buy milk");

    expect(await value(await page.inputValue({ by: "label", text: "New todo" }))).toBe("Buy milk");
  });

  it("can be made to fail any call, so error handling above it is reachable", async () => {
    const page = session({
      pages: { "/": { elements: ELEMENTS } },
      fail: (call) =>
        call.method === "click"
          ? { code: "action_failed", message: "the button is covered" }
          : undefined,
    });

    const clicked = await page.click({ by: "testId", id: "add" });

    expect(clicked).toEqual({
      ok: false,
      error: { code: "action_failed", message: "the button is covered" },
    });
  });

  it("presses a key on the page without needing an element", async () => {
    const keys: string[] = [];
    const page = session({
      pages: { "/": { elements: ELEMENTS } },
      on: { press: ({ key }) => void keys.push(key ?? "") },
    });

    expect((await page.press("Escape")).ok).toBe(true);
    expect(keys).toEqual(["Escape"]);
  });
});

describe("navigation and reload", () => {
  it("fails to navigate somewhere the application does not serve", async () => {
    const page = session();

    const gone = await page.goto("https://preview.example/missing");

    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.error.code).toBe("navigation_failed");
  });

  it("serves a declared path for its query strings too", async () => {
    // A filter that lives in the query is one page as far as the application is concerned.
    const page = new ScriptedBrowserSession({ pages: { "/": {}, "/todos": {} } });

    expect((await page.goto("https://preview.example/todos?filter=done")).ok).toBe(true);
    expect(await value(await page.url())).toBe("https://preview.example/todos?filter=done");
  });

  it("throws away what the application did not save, and keeps what it did", async () => {
    const page = session({
      pages: { "/": { elements: ELEMENTS } },
      on: {
        click: ({ page: live }) => {
          live.add({ text: "Unsaved" });
          live.add({ text: "Saved" }, { persists: true });
        },
      },
    });

    await page.click({ by: "testId", id: "add" });
    await page.reload();

    expect(await value(await page.isVisible({ by: "text", text: "Unsaved" }))).toBe(false);
    expect(await value(await page.isVisible({ by: "text", text: "Saved" }))).toBe(true);
  });

  it("keeps saved state under one key, whatever the address's query says", async () => {
    // A to-do deleted while a filter is applied is still deleted when it is not. Keying saved
    // state on the full address made a removal come back after a reload.
    const page = new ScriptedBrowserSession({
      pages: { "/": {}, "/todos": { elements: [{ testId: "add", role: "button" }] } },
      on: {
        click: ({ page: live }) =>
          live.add({ text: "Buy milk", testId: "todo" }, { persists: true }),
        press: ({ page: live }) => live.remove({ by: "testId", id: "todo" }),
      },
    });

    await page.goto("https://preview.example/todos");
    await page.click({ by: "testId", id: "add" });
    // The filter moves into the query, and the same saved to-do is deleted from there.
    await page.goto("https://preview.example/todos?filter=all");
    expect(await value(await page.isVisible({ by: "text", text: "Buy milk" }))).toBe(true);
    await page.press("Delete");
    await page.reload();

    expect(await value(await page.isVisible({ by: "text", text: "Buy milk" }))).toBe(false);
  });

  it("does not save a change to a saved element unless it is told to", async () => {
    const page = session({
      pages: { "/": { elements: ELEMENTS } },
      on: {
        click: ({ page: live }) =>
          live.add({ text: "Buy milk", testId: "todo" }, { persists: true }),
        press: ({ page: live, key }) =>
          live.update(
            { by: "testId", id: "todo" },
            { text: "Buy oat milk" },
            {
              persists: key === "s",
            },
          ),
      },
    });

    await page.click({ by: "testId", id: "add" });
    await page.press("x");
    expect(await value(await page.isVisible({ by: "text", text: "Buy oat milk" }))).toBe(true);

    await page.reload();
    expect(await value(await page.isVisible({ by: "text", text: "Buy oat milk" }))).toBe(false);

    await page.press("s");
    await page.reload();
    expect(await value(await page.isVisible({ by: "text", text: "Buy oat milk" }))).toBe(true);
  });

  it("forgets a saved element that was later removed", async () => {
    const page = session({
      pages: { "/": { elements: ELEMENTS } },
      on: {
        click: ({ page: live }) => live.add({ text: "Saved", testId: "todo" }, { persists: true }),
        press: ({ page: live }) => live.remove({ by: "testId", id: "todo" }),
      },
    });

    await page.click({ by: "testId", id: "add" });
    await page.press("Delete");
    await page.reload();

    expect(await value(await page.isVisible({ by: "text", text: "Saved" }))).toBe(false);
  });
});

describe("measurement and lifecycle", () => {
  it("reports the viewport as the client width, and overflow only where declared", async () => {
    const page = new ScriptedBrowserSession({ pages: { "/": { scrollWidth: { mobile: 500 } } } });

    expect(await value(await page.documentWidth())).toEqual({
      scrollWidth: VIEWPORT_SIZES.desktop.width,
      clientWidth: VIEWPORT_SIZES.desktop.width,
    });

    await page.setViewport(VIEWPORT_SIZES.mobile);
    expect(await value(await page.documentWidth())).toEqual({
      scrollWidth: 500,
      clientWidth: VIEWPORT_SIZES.mobile.width,
    });
  });

  it("records every call, so a caller's sequence can be asserted on", async () => {
    const page = session();

    await page.setViewport(VIEWPORT_SIZES.mobile);
    await page.click({ by: "testId", id: "add" });

    expect(page.calls.map((call) => call.method)).toEqual(["setViewport", "click"]);
  });

  it("photographs at whatever size the viewport currently is", async () => {
    // The contract the real adapter has to keep: nobody passes a size, so a check that ran at
    // mobile is photographed at mobile without anything having to remember to say so.
    const page = session({ screenshotBytes: new Uint8Array([1, 2, 3]) });
    await page.setViewport(VIEWPORT_SIZES.mobile);

    expect(await value(await page.screenshot())).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      viewport: VIEWPORT_SIZES.mobile,
    });
  });

  it("reports the violations declared for the page it is on", async () => {
    const violation = {
      id: "image-alt",
      impact: "critical" as const,
      help: "Images must have alternate text",
      helpUrl: "https://example.invalid/image-alt",
      nodes: 2,
    };
    const page = new ScriptedBrowserSession({
      pages: { "/": {}, "/about": { violations: [violation] } },
    });

    expect(await value(await page.scanAccessibility())).toEqual({ violations: [] });
    await page.goto("https://preview.example/about");
    expect(await value(await page.scanAccessibility())).toEqual({ violations: [violation] });
  });

  it("hands back the console errors and failed requests it was scripted with", async () => {
    const page = session({
      consoleErrors: ["TypeError: undefined is not a function"],
      failedRequests: [{ url: "https://preview.example/data.json", failure: "404" }],
    });

    expect(await value(await page.diagnostics())).toEqual({
      consoleErrors: ["TypeError: undefined is not a function"],
      failedRequests: [{ url: "https://preview.example/data.json", failure: "404" }],
    });
  });

  it("refuses everything once it is closed", async () => {
    const page = session();
    await page.close();

    const clicked = await page.click({ by: "testId", id: "add" });

    expect(clicked.ok).toBe(false);
    if (!clicked.ok) expect(clicked.error.code).toBe("unavailable");
  });
});
