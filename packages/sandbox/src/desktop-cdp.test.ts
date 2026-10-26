import { afterEach, expect, it, vi } from "vitest";
import { observeDesktopPage } from "./desktop-cdp.ts";

type Sent = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
type Reply = Record<string, unknown> | string;
const APP = { targetId: "app", type: "page", url: "http://localhost:5173/" };

/** A browser behind the bridge: browser-level targets plus a page that answers `page`. */
class Browser extends EventTarget {
  closed = 0;
  readonly sent: Sent[] = [];
  constructor(
    readonly page: (message: Sent) => Reply[],
    readonly targets: Record<string, unknown>[] = [APP],
  ) {
    super();
  }
  send(data: string) {
    const message = JSON.parse(data) as Sent;
    this.sent.push(message);
    const { id, method } = message;
    const replies: Reply[] =
      method === "Target.getTargets"
        ? [{ id, result: { targetInfos: this.targets } }]
        : method === "Target.attachToTarget"
          ? [{ id, result: { sessionId: "ours" } }]
          : this.page(message);
    for (const reply of replies)
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: typeof reply === "string" ? reply : JSON.stringify(reply),
          }),
        ),
      );
  }
  close() {
    this.closed++;
  }
  get methods() {
    return this.sent.map((message) => message.method);
  }
  connect = () => {
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
    return this;
  };
}
/** A page reply in our session, as Chrome sends one on a flat session. */
const reply = (message: Sent, result: unknown) => ({
  id: message.id,
  sessionId: message.sessionId,
  result,
});
const dom = (html: string) => (message: Sent) => [
  reply(
    message,
    message.method === "DOM.getDocument"
      ? { root: { nodeId: 1 } }
      : message.method === "DOM.querySelector"
        ? { nodeId: 2 }
        : { outerHTML: html },
  ),
];
const DOM_READ = [
  "Target.getTargets",
  "Target.attachToTarget",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.getOuterHTML",
];

afterEach(() => {
  vi.useRealTimers();
});

it("reads DOM through fixed operations on its own flat session, then closes", async () => {
  const browser = new Browser(dom("<main>App</main>"));
  expect(await observeDesktopPage("dom", { createSocket: browser.connect })).toBe(
    "<main>App</main>",
  );
  expect(browser.methods).toEqual(DOM_READ);
  expect(browser.sent[1]?.params).toEqual({ targetId: "app", flatten: true });
  expect(browser.sent.slice(0, 2).map((message) => message.sessionId)).toEqual([
    undefined,
    undefined,
  ]);
  expect(browser.sent.slice(2, 5).map((message) => message.sessionId)).toEqual([
    "ours",
    "ours",
    "ours",
  ]);
  expect(browser.closed).toBe(1);
});

it("reads console and log notifications from its own session without running page JavaScript", async () => {
  const browser = new Browser((message) => [
    ...(message.method === "Log.enable"
      ? [
          {
            method: "Log.entryAdded",
            sessionId: "ours",
            params: { entry: { level: "error", text: "Broken route" } },
          },
          {
            method: "Log.entryAdded",
            sessionId: "theirs",
            params: { entry: { level: "error", text: "Another client's page" } },
          },
          {
            method: "Log.entryAdded",
            params: { entry: { level: "error", text: "Browser-level" } },
          },
        ]
      : [
          {
            method: "Runtime.consoleAPICalled",
            sessionId: "ours",
            params: { type: "log", args: [{ value: "Ready" }] },
          },
        ]),
    reply(message, {}),
  ]);
  const result = await observeDesktopPage("console", { createSocket: browser.connect });
  expect(result).toBe("[error] Broken route\n[log] Ready");
  expect(browser.methods).toEqual([
    "Target.getTargets",
    "Target.attachToTarget",
    "Log.enable",
    "Runtime.enable",
  ]);
  expect(browser.closed).toBe(1);
});

it("accepts a reply only from the session that was asked", async () => {
  const browser = new Browser((message) => [
    { id: message.id, sessionId: "theirs", result: { outerHTML: "<main>Other page</main>" } },
    { id: message.id, result: { outerHTML: "<main>Browser-level</main>" } },
    ...dom("<main>App</main>")(message),
  ]);
  expect(await observeDesktopPage("dom", { createSocket: browser.connect })).toBe(
    "<main>App</main>",
  );
});

it.each(["dom", "console"] as const)(
  "observes the web page for %s when Chrome lists browser UI page targets first",
  async (kind) => {
    const browser = new Browser(dom("<main>Blocked by your organization</main>"), [
      { targetId: "omnibox", type: "page", url: "chrome://omnibox-popup.top-chrome/" },
      { targetId: "app", type: "page", url: "https://example.com/" },
      {
        targetId: "aim",
        type: "page",
        url: "chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html",
      },
    ]);
    const result = await observeDesktopPage(kind, { createSocket: browser.connect });
    expect(browser.sent[1]?.params).toEqual({ targetId: "app", flatten: true });
    if (kind === "dom") expect(result).toContain("Blocked by your organization");
    expect(browser.closed).toBe(1);
  },
);

it.each([
  "http://localhost:5173/",
  "https://example.com/",
  "about:blank",
  "chrome-error://chromewebdata/",
])("observes a web-content target at %s", async (url) => {
  const browser = new Browser(dom("<main>App</main>"), [{ ...APP, url }]);
  expect(await observeDesktopPage("dom", { createSocket: browser.connect })).toBe(
    "<main>App</main>",
  );
});

it.each([
  ["page", "chrome://omnibox-popup.top-chrome/"],
  ["page", "chrome://newtab/"],
  ["page", "chrome-extension://extension/popup.html"],
  ["page", "devtools://devtools/bundled/inspector.html"],
  ["browser_ui", "chrome://omnibox-popup.top-chrome/"],
  ["service_worker", "http://localhost:5173/sw.js"],
])("does not observe a %s target at %s when no web page exists", async (type, url) => {
  const browser = new Browser(dom("<main>App</main>"), [{ targetId: "ui", type, url }]);
  await expect(observeDesktopPage("dom", { createSocket: browser.connect })).rejects.toThrow(
    "No browser page is open.",
  );
  expect(browser.methods).toEqual(["Target.getTargets"]);
  expect(browser.closed).toBe(1);
});

it("prioritizes body DOM when a large head would hide the visible page message", async () => {
  const body =
    "<body><main>This page is blocked. Your organization does not allow this site.</main></body>";
  const full = `<html><head><style>${"x".repeat(130000)}</style></head>${body}</html>`;
  const browser = new Browser((message) => [
    reply(
      message,
      message.method === "DOM.getDocument"
        ? { root: { nodeId: 1 } }
        : message.method === "DOM.querySelector"
          ? { nodeId: message.params.selector === "body" ? 2 : 0 }
          : { outerHTML: message.params.nodeId === 2 ? body : full },
    ),
  ]);
  expect(await observeDesktopPage("dom", { createSocket: browser.connect })).toBe(body);
  expect(browser.methods).toEqual(DOM_READ);
});

it("marks incomplete body observations within the existing DOM character limit", async () => {
  const browser = new Browser(dom(`<body>${"x".repeat(130000)}</body>`));
  const result = await observeDesktopPage("dom", { createSocket: browser.connect });
  expect(result.length).toBe(120000);
  expect(result.startsWith("<body>")).toBe(true);
  expect(result.endsWith("[DOM truncated]")).toBe(true);
});

it("falls back to the document for pages without a body", async () => {
  const browser = new Browser((message) => [
    reply(
      message,
      message.method === "DOM.getDocument"
        ? { root: { nodeId: 1 } }
        : message.method === "DOM.querySelector"
          ? { nodeId: 0 }
          : { outerHTML: message.params.nodeId === 1 ? "<svg>Drawing</svg>" : "" },
    ),
  ]);
  expect(await observeDesktopPage("dom", { createSocket: browser.connect })).toBe(
    "<svg>Drawing</svg>",
  );
});

it.each([{ nodeId: -1 }, { nodeId: "body" }, {}])(
  "rejects malformed body query responses without a follow-up DOM read",
  async (result) => {
    const browser = new Browser((message) => [
      reply(message, message.method === "DOM.getDocument" ? { root: { nodeId: 1 } } : result),
    ]);
    await expect(observeDesktopPage("dom", { createSocket: browser.connect })).rejects.toThrow();
    expect(browser.methods).toEqual([
      "Target.getTargets",
      "Target.attachToTarget",
      "DOM.getDocument",
      "DOM.querySelector",
    ]);
    expect(browser.closed).toBe(1);
  },
);

it.each([
  ["a target list of the wrong shape", { targetInfos: [{ type: "page" }] }, "Target.getTargets"],
  ["an attachment without a session", { sessionId: "" }, "Target.attachToTarget"],
])("rejects %s and closes", async (_name, result, method) => {
  const browser = new Browser(dom("<main>App</main>"));
  const send = browser.send.bind(browser);
  browser.send = (data: string) => {
    const message = JSON.parse(data) as Sent;
    if (message.method !== method) return send(data);
    browser.sent.push(message);
    queueMicrotask(() =>
      browser.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify({ id: message.id, result }) }),
      ),
    );
  };
  await expect(observeDesktopPage("dom", { createSocket: browser.connect })).rejects.toThrow();
  expect(browser.methods).not.toContain("DOM.getDocument");
  expect(browser.closed).toBe(1);
});

it.each([
  ["text that is not JSON", "not json", "Invalid browser response."],
  ["a frame of the wrong shape", JSON.stringify({ id: "1" }), "Invalid browser response."],
  ["an oversized frame", JSON.stringify({ pad: "x".repeat(1_000_000) }), "too large"],
])("fails on %s and still closes", async (_name, frame, error) => {
  const browser = new Browser((message) =>
    message.method === "DOM.getDocument" ? [frame] : dom("<main>App</main>")(message),
  );
  await expect(observeDesktopPage("dom", { createSocket: browser.connect })).rejects.toThrow(error);
  expect(browser.methods.at(-1)).toBe("DOM.getDocument");
  expect(browser.closed).toBe(1);
});

it("fails when the connection reports a frame beyond its own limit", async () => {
  const browser = new Browser((message) => {
    if (message.method === "DOM.getOuterHTML")
      queueMicrotask(() => browser.dispatchEvent(new Event("overflow")));
    return message.method === "DOM.getOuterHTML" ? [] : dom("")(message);
  });
  await expect(observeDesktopPage("dom", { createSocket: browser.connect })).rejects.toThrow(
    "Browser observation is too large.",
  );
  expect(browser.closed).toBe(1);
});

it("reports an unreachable debugger as unavailable", async () => {
  const browser = new Browser(dom(""));
  await expect(
    observeDesktopPage("dom", {
      createSocket: () => {
        queueMicrotask(() => browser.dispatchEvent(new Event("error")));
        return browser;
      },
    }),
  ).rejects.toThrow("Browser debugger is unavailable.");
  expect(browser.sent).toEqual([]);
  expect(browser.closed).toBe(1);
});

it("does not connect for an aborted observation", async () => {
  let connected = false;
  await expect(
    observeDesktopPage("dom", {
      signal: AbortSignal.abort(),
      createSocket: () => {
        connected = true;
        return new Browser(dom(""));
      },
    }),
  ).rejects.toThrow();
  expect(connected).toBe(false);
});

it("stops and closes when cancelled mid-observation", async () => {
  const controller = new AbortController();
  const browser = new Browser((message) => {
    if (message.method === "DOM.getDocument") queueMicrotask(() => controller.abort());
    return message.method === "DOM.getDocument" ? [] : dom("")(message);
  });
  await expect(
    observeDesktopPage("dom", { createSocket: browser.connect, signal: controller.signal }),
  ).rejects.toThrow("Browser observation cancelled.");
  expect(browser.methods.at(-1)).toBe("DOM.getDocument");
  expect(browser.closed).toBe(1);
});

it("gives up after its five-second deadline, including a connection that never opens", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const browser = new Browser(dom(""));
  const observation = observeDesktopPage("dom", { createSocket: () => browser });
  const settled = expect(observation).rejects.toThrow("Browser observation timed out.");
  await vi.advanceTimersByTimeAsync(4999);
  expect(browser.closed).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  await settled;
  expect(browser.closed).toBe(1);
});

it("fails rather than waits when the bridge disconnects", async () => {
  const browser = new Browser((message) => {
    if (message.method === "DOM.getDocument")
      queueMicrotask(() => browser.dispatchEvent(new Event("close")));
    return message.method === "DOM.getDocument" ? [] : dom("")(message);
  });
  await expect(observeDesktopPage("dom", { createSocket: browser.connect })).rejects.toThrow(
    "Browser observation disconnected.",
  );
});
