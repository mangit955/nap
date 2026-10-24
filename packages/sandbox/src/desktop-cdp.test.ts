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
const target = [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1" }];
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
        { type: "page", webSocketDebuggerUrl: "wss://example.com/private" },
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
