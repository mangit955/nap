/**
 * The Playwright adapter, observed working — every action, every query, against a real Chrome.
 *
 * **Needs: a Chrome or Chromium binary named by `NAP_CHROME_PATH`.** No network, no credentials,
 * no sandbox, no money. It serves its own application on a loopback port, the way the capture
 * package's browser test does. Without the variable the whole file skips.
 *
 * Driving a *real preview* additionally needs an E2B sandbox and credentials; that is what
 * `scripts/preview-reachability.ts` bought, and nothing here repeats it. The split is deliberate
 * — this file answers "does the adapter do what the port promises", which is the expensive
 * question to get wrong and the cheap one to ask.
 *
 * The fixture is shaped like something an agent would produce: an empty `#root` that only script
 * fills, so a passing test cannot be explained by content that arrived in the HTML. It has a
 * to-do list with a filter and a persisting store, because that is the shape of the checks the
 * benchmark's tasks are made of — including the one that matters most, whether state survives a
 * reload.
 *
 * One test per group rather than one per assertion: launching Chrome is the expensive part, and
 * splitting further would pay it repeatedly to learn the same things.
 */

import { createServer, type Server } from "node:http";
import { runBrowserCheck } from "@nap/bench/browser-executor";
import type { BrowserSession } from "@nap/bench/browser-session";
import { VIEWPORT_SIZES } from "@nap/bench/viewport";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  launchPlaywrightBrowser,
  type PlaywrightBrowserDriver,
} from "./playwright-browser-session.ts";

const CHROME = process.env.NAP_CHROME_PATH;

/**
 * A to-do list that saves to `localStorage`, has a filter in the query string, and renders
 * nothing without script. Deliberately imperfect: the image has no `alt`, so the accessibility
 * scan has something real to find rather than being asserted against an empty array.
 */
const APP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Todos</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<div id="root"></div>
<script>
  const root = document.getElementById("root");
  const saved = JSON.parse(localStorage.getItem("todos") || "[]");
  const params = new URLSearchParams(location.search);

  root.innerHTML = \`
    <h1>Todos</h1>
    <img src="/logo.png" data-testid="logo">
    <label for="new-todo">New todo</label>
    <input id="new-todo" data-testid="field">
    <button data-testid="add" disabled>Add</button>
    <label for="filter">Filter</label>
    <select id="filter"><option value="all">All</option><option value="done">Done</option></select>
    <ul data-testid="list"></ul>
    <p id="empty">Nothing to do yet</p>\`;

  const list = root.querySelector("ul");
  const field = root.querySelector("input");
  const add = root.querySelector("button");
  const empty = root.querySelector("#empty");

  const render = () => {
    const showing = params.get("filter") === "done" ? [] : saved;
    list.innerHTML = showing.map((text) => "<li>" + text + "</li>").join("");
    empty.style.display = showing.length === 0 ? "block" : "none";
  };

  field.addEventListener("input", () => { add.disabled = field.value === ""; });
  const submit = () => {
    if (field.value === "") return;
    saved.push(field.value);
    localStorage.setItem("todos", JSON.stringify(saved));
    field.value = "";
    add.disabled = true;
    render();
  };
  add.addEventListener("click", submit);
  field.addEventListener("keydown", (event) => { if (event.key === "Enter") submit(); });
  root.querySelector("select").addEventListener("change", (event) => {
    params.set("filter", event.target.value);
    history.pushState({}, "", "?" + params);
    render();
  });

  render();
</script></body></html>`;

/** A page that spills past a phone's width, so overflow is measured rather than asserted. */
const WIDE = `<!doctype html><html><head><title>Wide</title></head>
<body style="margin:0"><div style="width:900px;height:40px">wide</div></body></html>`;

/** Throws on load, which is the error a check never sees and diagnostics must. */
const BROKEN = `<!doctype html><html><head><title>Broken</title></head><body>
<div id="root">Looks fine</div>
<script>fetch("/data.json"); throw new TypeError("cannot read properties of undefined");</script>
</body></html>`;

const PAGES: Record<string, string> = { "/": APP, "/wide": WIDE, "/broken": BROKEN };

let server: Server;
let origin: string;
/**
 * Recorded server-side, because the favicon request is not visible on Playwright's `request`
 * event and the test below has to prove Chrome asked before it can prove we filtered it.
 */
const pathsRequested: string[] = [];
let driver: PlaywrightBrowserDriver;

/** A session per test, so nothing one test stored can explain another one passing. */
async function openSession(): Promise<BrowserSession> {
  const opened = await driver.session();
  if (!opened.ok) throw new Error(`no session: ${opened.error.message}`);
  return opened.value;
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(`the adapter failed: ${result.error.message}`);
  return result.value;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    pathsRequested.push(path);
    const page = PAGES[path];
    if (page === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${address.port}`;

  if (CHROME === undefined) return;
  const launched = await launchPlaywrightBrowser({ executablePath: CHROME });
  if (!launched.ok) throw new Error(`no browser: ${launched.error.message}`);
  driver = launched.value;
});

afterAll(async () => {
  await driver?.close();
  server?.close();
});

describe("launching", () => {
  it("reports a missing binary as a typed failure rather than throwing", async () => {
    // The one case that must not be an exception: it reaches the gate ladder as an evaluator
    // fault, where the alternative is a crashed run charged to the agent. Needs no Chrome, so
    // it is outside the skip below.
    const launched = await launchPlaywrightBrowser({
      executablePath: "/nowhere/there-is-no-chrome-here",
    });

    expect(launched.ok).toBe(false);
    if (!launched.ok) {
      expect(launched.error.code).toBe("unavailable");
      expect(launched.error.message).toContain("/nowhere/there-is-no-chrome-here");
    }
  });
});

describe.skipIf(CHROME === undefined)("the Playwright adapter against a real Chrome", () => {
  it("performs every action and answers every query", async () => {
    const session = await openSession();
    try {
      unwrap(await session.goto(origin));

      // Queries, against a page only script could have produced.
      expect(unwrap(await session.isVisible({ by: "role", role: "heading", name: "Todos" }))).toBe(
        true,
      );
      expect(unwrap(await session.isVisible({ by: "text", text: "Nothing to do yet" }))).toBe(true);
      expect(unwrap(await session.count({ by: "role", role: "listitem" }))).toBe(0);
      expect(
        unwrap(await session.attribute({ by: "testId", id: "add" }, "disabled")),
      ).not.toBeNull();
      expect(unwrap(await session.attribute({ by: "testId", id: "logo" }, "alt"))).toBeNull();
      expect(unwrap(await session.inputValue({ by: "label", text: "New todo" }))).toBe("");
      expect(unwrap(await session.url())).toContain(origin);

      // Actions.
      unwrap(await session.fill({ by: "label", text: "New todo" }, "Buy milk"));
      expect(unwrap(await session.inputValue({ by: "label", text: "New todo" }))).toBe("Buy milk");
      // The button was disabled until the field had a value, so this also proves `fill`
      // dispatched real input events rather than setting a property.
      expect(unwrap(await session.attribute({ by: "testId", id: "add" }, "disabled"))).toBeNull();

      unwrap(await session.click({ by: "role", role: "button", name: "Add" }));
      expect(unwrap(await session.isVisible({ by: "text", text: "Buy milk" }))).toBe(true);
      expect(unwrap(await session.count({ by: "role", role: "listitem" }))).toBe(1);
      // The empty-state paragraph is still in the document with `display: none`. Visible ones
      // only, as the port says — markup a user cannot see is not something they can count.
      expect(unwrap(await session.count({ by: "text", text: "Nothing to do yet" }))).toBe(0);
      expect(
        unwrap(
          await session.isVisible({ by: "text", text: "Nothing to do yet" }, { timeoutMs: 500 }),
        ),
      ).toBe(false);

      unwrap(await session.press("Enter", { by: "label", text: "New todo" }));
      unwrap(await session.fill({ by: "label", text: "New todo" }, "Walk dog"));
      unwrap(await session.press("Enter", { by: "label", text: "New todo" }));
      expect(unwrap(await session.count({ by: "role", role: "listitem" }))).toBe(2);

      // The one that cannot be faked: a reload proves the application really stored them.
      // Before the filter, deliberately — a reload carries the query with it, so afterwards an
      // empty list would mean the filter worked rather than that persistence failed.
      unwrap(await session.reload());
      expect(unwrap(await session.isVisible({ by: "text", text: "Buy milk" }))).toBe(true);
      expect(unwrap(await session.count({ by: "role", role: "listitem" }))).toBe(2);

      unwrap(await session.selectOption({ by: "label", text: "Filter" }, "done"));
      expect(unwrap(await session.url())).toContain("filter=done");
      expect(unwrap(await session.count({ by: "role", role: "listitem" }))).toBe(0);
    } finally {
      await session.close();
    }
  });

  it("answers false for something that is not there, rather than failing", async () => {
    const session = await openSession();
    try {
      unwrap(await session.goto(origin));

      // Absence is an answer to "is this visible", and the whole `expectNoText` assertion rests
      // on it. A short deadline, because proving a negative costs the full wait.
      expect(
        unwrap(await session.isVisible({ by: "text", text: "Buy milk" }, { timeoutMs: 500 })),
      ).toBe(false);

      // Asking an element that is not there for an attribute is a different thing: there is no
      // answer to give, so it is a typed failure.
      const missing = await session.attribute({ by: "testId", id: "nope" }, "href", {
        timeoutMs: 500,
      });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe("not_found");
    } finally {
      await session.close();
    }
  });

  it("fails to navigate to a page that does not answer, without blaming the browser", async () => {
    const session = await openSession();
    try {
      const gone = await session.goto("http://127.0.0.1:1/", { timeoutMs: 5_000 });

      expect(gone.ok).toBe(false);
      // Not `unavailable`: the browser is fine, the application is not there. Only the first of
      // those errors a run.
      if (!gone.ok) expect(gone.error.code).toBe("navigation_failed");
    } finally {
      await session.close();
    }
  });

  it("measures the document against the viewport it was laid out at", async () => {
    const session = await openSession();
    try {
      unwrap(await session.setViewport(VIEWPORT_SIZES.mobile));
      unwrap(await session.goto(`${origin}/wide`));

      const width = unwrap(await session.documentWidth());
      expect(width.clientWidth).toBe(VIEWPORT_SIZES.mobile.width);
      expect(width.scrollWidth).toBeGreaterThan(width.clientWidth);

      // And the same page at desktop, where 900px fits: the numbers come from the layout
      // rather than from the markup.
      unwrap(await session.setViewport(VIEWPORT_SIZES.desktop));
      const wide = unwrap(await session.documentWidth());
      expect(wide.scrollWidth).toBeLessThanOrEqual(wide.clientWidth);
    } finally {
      await session.close();
    }
  });

  it("photographs at the viewport the check ran at, after the interaction", async () => {
    const session = await openSession();
    try {
      // Through the executor, because "the viewport the check ran at" is a fact about a check
      // rather than an argument anybody passes.
      const outcome = await runBrowserCheck(
        session,
        {
          id: "adds-a-todo",
          kind: "browser",
          viewport: "mobile",
          steps: [
            { step: "fill", selector: { by: "label", text: "New todo" }, value: "Buy milk" },
            { step: "click", selector: { by: "role", role: "button", name: "Add" } },
            { step: "expectText", text: "Buy milk" },
            { step: "reload" },
            { step: "expectText", text: "Buy milk" },
            { step: "expectCount", selector: { by: "role", role: "listitem" }, count: 1 },
          ],
        },
        { baseUrl: origin },
      );

      expect(unwrap(outcome).outcome).toBe("passed");

      const shot = unwrap(await session.screenshot());
      expect(shot.viewport).toEqual(VIEWPORT_SIZES.mobile);
      // A PNG, not an empty file: the first eight bytes are the format's signature.
      expect([...shot.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    } finally {
      await session.close();
    }
  });

  it("fails a check the application does not satisfy, through the same executor", async () => {
    // The other direction, and the one a benchmark is for: the browser worked and the page was
    // not what was asked for.
    const session = await openSession();
    try {
      const outcome = await runBrowserCheck(
        session,
        {
          id: "wrong",
          kind: "browser",
          timeoutMs: 1_000,
          steps: [{ step: "expectText", text: "A heading nobody wrote" }],
        },
        { baseUrl: origin },
      );

      expect(unwrap(outcome).outcome).toBe("failed");
      expect(unwrap(outcome).detail).toContain("assertion expectText");
    } finally {
      await session.close();
    }
  });

  it("finds a real accessibility violation with the established tool", async () => {
    const session = await openSession();
    try {
      unwrap(await session.goto(origin));

      const scan = unwrap(await session.scanAccessibility());

      // The fixture's image has no `alt`, deliberately, so this asserts the scan *found*
      // something rather than that it ran and said nothing.
      const imageAlt = scan.violations.find((violation) => violation.id === "image-alt");
      expect(imageAlt).toBeDefined();
      expect(imageAlt?.nodes).toBe(1);
      expect(imageAlt?.impact).toBe("critical");
      expect(imageAlt?.helpUrl).toContain("image-alt");
    } finally {
      await session.close();
    }
  });

  it("collects console errors and failed requests, and filters the favicon", async () => {
    // Its own browser, and the reason is a finding in itself: Chrome asks for `/favicon.ico`
    // **once per browser process**, not once per page — it remembers the 404 across contexts.
    // So the noise this filter exists for lands on whichever check runs first in a suite and
    // never again, and a test sharing the suite's browser could only ever assert the filter on
    // a page that was never going to produce the thing being filtered.
    const own = await launchPlaywrightBrowser({ executablePath: CHROME ?? "" });
    if (!own.ok) throw new Error(`no browser: ${own.error.message}`);
    const opened = await own.value.session();
    if (!opened.ok) throw new Error(`no session: ${opened.error.message}`);
    const session = opened.value;
    const before = pathsRequested.length;
    try {
      unwrap(await session.goto(`${origin}/broken`));

      const diagnostics = unwrap(await session.diagnostics());

      // The uncaught exception, which no assertion in any check would have noticed: the page
      // renders "Looks fine".
      expect(diagnostics.consoleErrors.join("\n")).toContain("cannot read properties of undefined");
      // Every console error says *what* it was about. Chrome's own text for a failed resource
      // names nothing, which is a line worth nothing in a report read months later.
      expect(diagnostics.consoleErrors.join("\n")).toContain(`${origin}/data.json`);

      // The 404 on the data fetch, recorded as the response it was. Chrome also aborts that
      // request once nothing reads the body, so it arrives twice by two routes — asserting on
      // the status is what pins the one that means "this application asked for something that
      // is not there" rather than "the browser gave up".
      expect(diagnostics.failedRequests).toContainEqual({
        url: `${origin}/data.json`,
        failure: "HTTP 404",
      });

      // The scenario is real before it is filtered: Chrome asked for the favicon and this
      // server 404d it, exactly as the sandbox template does. Asserting the filter without
      // this would pass on a run where the request never happened.
      expect(pathsRequested.slice(before)).toContain("/favicon.ico");
      // Two errors and no more — the uncaught exception and the missing data. A third would be
      // the favicon getting through, which is only visible at all because the source URL is
      // kept: Chrome's text for both 404s is identical and names neither.
      expect(diagnostics.consoleErrors).toHaveLength(2);
      // And it is nowhere in either list. Every application the benchmark runs produces this,
      // so leaving it in would penalise all of them equally.
      expect(JSON.stringify(diagnostics)).not.toContain("favicon");
    } finally {
      await session.close();
      await own.value.close();
    }
  });

  it("reports a closed session as unavailable, which is ours and not the agent's", async () => {
    const session = await openSession();
    unwrap(await session.goto(origin));
    await session.close();

    const asked = await session.isVisible({ by: "text", text: "Todos" }, { timeoutMs: 500 });

    expect(asked.ok).toBe(false);
    if (!asked.ok) expect(asked.error.code).toBe("unavailable");
  });

  it("gives each session a context of its own, so nothing leaks between checks", async () => {
    const first = await openSession();
    try {
      unwrap(await first.goto(origin));
      unwrap(await first.fill({ by: "label", text: "New todo" }, "Buy milk"));
      unwrap(await first.click({ by: "role", role: "button", name: "Add" }));
      expect(unwrap(await first.count({ by: "role", role: "listitem" }))).toBe(1);
    } finally {
      await first.close();
    }

    const second = await openSession();
    try {
      unwrap(await second.goto(origin));
      // The same `localStorage` key, and none of it: a check that passed on what the last one
      // saved would be measuring the wrong thing.
      expect(unwrap(await second.count({ by: "role", role: "listitem" }))).toBe(0);
    } finally {
      await second.close();
    }
  });
});
