/**
 * The parts of the Playwright adapter that need no Playwright.
 *
 * Three small functions carry the decisions in that file — what counts as noise, what a thrown
 * value means, and what survives of an accessibility run — and each is the sort of thing that is
 * wrong quietly. The rest of the adapter is behaviour a fake cannot stand in for, and is covered
 * by the integration test beside this one against a real Chrome.
 */

import { describe, expect, it } from "vitest";
import {
  browserErrorFor,
  isBrowserNoise,
  summariseViolations,
} from "./playwright-browser-session.ts";

/** Playwright's own error, as far as anything here can tell it apart: the name. */
function timeout(message = "Timeout 5000ms exceeded"): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

describe("isBrowserNoise", () => {
  it("filters the favicon every generated application 404s", () => {
    // Measured, not assumed: the sandbox template declares no icon, so Chrome asks for this on
    // every run of every task. Left in, it would penalise all of them equally.
    expect(isBrowserNoise("https://5173-abc.e2b.app/favicon.ico")).toBe(true);
    expect(isBrowserNoise("http://127.0.0.1:5173/favicon.ico?v=2")).toBe(true);
  });

  it("keeps everything a task might actually care about", () => {
    expect(isBrowserNoise("https://5173-abc.e2b.app/api/todos")).toBe(false);
    expect(isBrowserNoise("https://5173-abc.e2b.app/assets/index.js")).toBe(false);
    // Not a path called favicon.ico — a real request that happens to mention it.
    expect(isBrowserNoise("https://5173-abc.e2b.app/img?src=/favicon.ico")).toBe(false);
  });

  it("keeps a source that is not a URL at all", () => {
    // A console error from an inline script has no address to filter on.
    expect(isBrowserNoise("")).toBe(false);
  });
});

describe("browserErrorFor", () => {
  it("reads a timed-out element wait as the element not being there", () => {
    expect(browserErrorFor(timeout(), "element").code).toBe("not_found");
  });

  it("reads any navigation failure as one, timeout or not", () => {
    expect(browserErrorFor(timeout(), "navigation").code).toBe("navigation_failed");
    expect(browserErrorFor(new Error("net::ERR_CONNECTION_REFUSED"), "navigation").code).toBe(
      "navigation_failed",
    );
  });

  it("does not call a non-timeout an absence", () => {
    // An element that is there and would not be clicked is a different finding from one that
    // never appeared, and only the second is "the application did not render it".
    expect(browserErrorFor(new Error("element is not enabled"), "element").code).toBe(
      "action_failed",
    );
  });

  it("keeps what went wrong in the message", () => {
    expect(browserErrorFor(new Error('Unknown role "buttonn"'), "element").message).toContain(
      "buttonn",
    );
    expect(browserErrorFor("something threw a string", "page").message).toBe(
      "something threw a string",
    );
  });

  it("never reports a missing browser, which is decided before it is called", () => {
    // `unavailable` is the one code that ends a run rather than failing a check, and it comes
    // from asking the page whether it is still open — never from guessing at a message.
    for (const where of ["navigation", "element", "page"] as const) {
      expect(browserErrorFor(new Error("Target page has been closed"), where).code).not.toBe(
        "unavailable",
      );
    }
  });
});

describe("summariseViolations", () => {
  const violation = {
    id: "image-alt",
    impact: "critical" as const,
    help: "Images must have alternate text",
    helpUrl: "https://dequeuniversity.com/rules/axe/4.13/image-alt",
    description: "Ensures <img> elements have alternate text",
    tags: ["wcag2a"],
    nodes: [{ html: "<img>" }, { html: "<img>" }],
  };

  it("keeps the rule, its impact, where to read about it and how many elements broke it", () => {
    // Not axe's own shape: a report is archived and diffed for months, and its result object is
    // a large versioned thing with a node tree inside it.
    expect(summariseViolations({ violations: [violation] as never })).toEqual([
      {
        id: "image-alt",
        impact: "critical",
        help: "Images must have alternate text",
        helpUrl: "https://dequeuniversity.com/rules/axe/4.13/image-alt",
        nodes: 2,
      },
    ]);
  });

  it("records an ungraded violation as unknown rather than as mild", () => {
    // The field is optional in axe's output. Defaulting to `minor` would understate a
    // violation in a report nobody can re-derive.
    const summarised = summariseViolations({
      violations: [{ ...violation, impact: undefined }] as never,
    });

    expect(summarised[0]?.impact).toBe("unknown");
  });

  it("says nothing about a clean page", () => {
    expect(summariseViolations({ violations: [] })).toEqual([]);
    expect(summariseViolations({})).toEqual([]);
  });
});
