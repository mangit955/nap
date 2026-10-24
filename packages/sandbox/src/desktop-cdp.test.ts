import { expect, it } from "vitest";
import { observeDesktopPage } from "./desktop-cdp.ts";

class Socket extends EventTarget {
  closed = 0;
  readonly methods: string[] = [];
  constructor(readonly result: (method: string, id: number) => unknown[]) {
    super();
  }
  send(data: string) {
    const { method, id } = JSON.parse(data) as { method: string; id: number };
    this.methods.push(method);
    for (const reply of this.result(method, id))
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(reply) })),
      );
  }
  close() {
    this.closed++;
  }
}
const target = [
  {
    type: "page",
    url: "http://localhost:5173/",
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1",
  },
];
it("reads DOM through fixed protocol operations and closes its connection", async () => {
  const socket = new Socket((method, id) => [
    {
      id,
      result:
        method === "DOM.getDocument" ? { root: { nodeId: 1 } } : { outerHTML: "<main>App</main>" },
    },
  ]);
  expect(
    await observeDesktopPage("dom", {
      fetchTargets: async () => target,
      createSocket: () => {
        queueMicrotask(() => socket.dispatchEvent(new Event("open")));
        return socket;
      },
    }),
  ).toBe("<main>App</main>");
  expect(socket.methods).toEqual(["DOM.getDocument", "DOM.getOuterHTML"]);
  expect(socket.closed).toBe(1);
});
it("reads existing console/log notifications without executing page JavaScript", async () => {
  const socket = new Socket((method, id) => [
    { id, result: {} },
    ...(method === "Log.enable"
      ? [{ method: "Log.entryAdded", params: { entry: { level: "error", text: "Broken route" } } }]
      : [
          {
            method: "Runtime.consoleAPICalled",
            params: { type: "log", args: [{ value: "Ready" }] },
          },
        ]),
  ]);
  const result = await observeDesktopPage("console", {
    fetchTargets: async () => target,
    createSocket: () => {
      queueMicrotask(() => socket.dispatchEvent(new Event("open")));
      return socket;
    },
  });
  expect(result).toContain("Broken route");
  expect(result).toContain("Ready");
  expect(socket.methods).toEqual(["Log.enable", "Runtime.enable"]);
  expect(socket.closed).toBe(1);
});
it("refuses non-loopback debugger targets before connecting", async () => {
  let connected = false;
  await expect(
    observeDesktopPage("dom", {
      fetchTargets: async () => [
        {
          type: "page",
          url: "http://localhost:5173/",
          webSocketDebuggerUrl: "wss://example.com/private",
        },
      ],
      createSocket: () => {
        connected = true;
        return new Socket(() => []);
      },
    }),
  ).rejects.toThrow();
  expect(connected).toBe(false);
});
it("rejects malformed protocol replies and closes the socket", async () => {
  const socket = new Socket((_method, id) => [{ id, result: { wrong: true } }]);
  await expect(
    observeDesktopPage("dom", {
      fetchTargets: async () => target,
      createSocket: () => {
        queueMicrotask(() => socket.dispatchEvent(new Event("open")));
        return socket;
      },
    }),
  ).rejects.toThrow();
  expect(socket.closed).toBe(1);
});
it("does not connect for an aborted observation", async () => {
  let read = false;
  await expect(
    observeDesktopPage("dom", {
      signal: AbortSignal.abort(),
      fetchTargets: async () => {
        read = true;
        return target;
      },
    }),
  ).rejects.toThrow();
  expect(read).toBe(false);
});

it.each(["dom", "console"] as const)(
  "observes the web page for %s when Chrome exposes internal page targets first",
  async (kind) => {
    const urls: string[] = [];
    const socket = new Socket((method, id) => [
      {
        id,
        result:
          method === "DOM.getDocument"
            ? { root: { nodeId: 1 } }
            : method === "DOM.getOuterHTML"
              ? { outerHTML: "<main>Blocked by your organization</main>" }
              : {},
      },
    ]);
    const result = await observeDesktopPage(kind, {
      fetchTargets: async () => [
        {
          type: "page",
          url: "chrome://omnibox-popup.top-chrome/",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/omnibox",
        },
        {
          type: "page",
          url: "https://example.com/",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/app",
        },
        {
          type: "page",
          url: "chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/aim",
        },
      ],
      createSocket: (url) => {
        urls.push(url);
        queueMicrotask(() => socket.dispatchEvent(new Event("open")));
        return socket;
      },
    });
    expect(urls).toEqual(["ws://127.0.0.1:9222/devtools/page/app"]);
    if (kind === "dom") expect(result).toContain("Blocked by your organization");
    expect(socket.closed).toBe(1);
  },
);

it.each([
  "http://localhost:5173/",
  "https://example.com/",
  "about:blank",
  "chrome-error://chromewebdata/",
])("observes a web-content target at %s", async (url) => {
  const socket = new Socket((method, id) => [
    {
      id,
      result:
        method === "DOM.getDocument" ? { root: { nodeId: 1 } } : { outerHTML: "<main>App</main>" },
    },
  ]);
  expect(
    await observeDesktopPage("dom", {
      fetchTargets: async () => [{ ...target[0], url }],
      createSocket: () => {
        queueMicrotask(() => socket.dispatchEvent(new Event("open")));
        return socket;
      },
    }),
  ).toBe("<main>App</main>");
});

it.each([
  "chrome://omnibox-popup.top-chrome/",
  "chrome://newtab/",
  "chrome-extension://extension/popup.html",
  "devtools://devtools/bundled/inspector.html",
])("does not observe browser UI at %s when no web page exists", async (url) => {
  let connected = false;
  await expect(
    observeDesktopPage("dom", {
      fetchTargets: async () => [{ ...target[0], url }],
      createSocket: () => {
        connected = true;
        return new Socket(() => []);
      },
    }),
  ).rejects.toThrow("No browser page is open.");
  expect(connected).toBe(false);
});
