import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

type CdpSocket = EventTarget & { send(data: string): void; close(): void };
type Options = {
  fetchTargets?: () => Promise<unknown>;
  createSocket?: (url: string) => CdpSocket;
  signal?: AbortSignal;
};
const Targets = z.array(
  z.object({ type: z.string(), url: z.string(), webSocketDebuggerUrl: z.string().optional() }),
);
const Envelope = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
});

/** Fixed, read-only CDP observations. There is no operation accepting page JavaScript. */
export async function observeDesktopPage(
  kind: "dom" | "console",
  options: Options = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  const raw = await (
    options.fetchTargets ??
    (async () => {
      const response = await fetch("http://127.0.0.1:9222/json/list", {
        signal: options.signal ?? null,
      });
      if (!response.ok) throw new Error("Browser debugger is unavailable.");
      return response.json();
    })
  )();
  options.signal?.throwIfAborted();
  // Chrome exposes omnibox and extension surfaces as page targets too.
  const address = Targets.parse(raw).find(
    (page) =>
      page.type === "page" &&
      (/^(?:https?:|chrome-error:)/.test(page.url) || page.url === "about:blank"),
  )?.webSocketDebuggerUrl;
  if (!address) throw new Error("No browser page is open.");
  const url = new URL(address);
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "9222" ||
    !url.pathname.startsWith("/devtools/page/")
  )
    throw new Error("Unexpected browser debugger address.");
  const socket = (options.createSocket ?? ((value) => new WebSocket(value)))(address);
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let resolveOpen = () => {};
  let rejectOpen = (_error: Error) => {};
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });
  const lines: string[] = [];
  const add = (text: string) => {
    lines.push(text.slice(0, 8192));
    if (lines.length > 1000) lines.shift();
  };
  const fail = (error: Error) => {
    rejectOpen(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const onOpen = () => resolveOpen();
  const onClose = () => fail(new Error("Browser observation disconnected."));
  const onAbort = () => fail(new Error("Browser observation cancelled."));
  const onMessage = (event: Event) => {
    if (!("data" in event) || typeof event.data !== "string") return;
    if (event.data.length > 1_000_000) {
      fail(new Error("Browser observation is too large."));
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(event.data);
    } catch {
      fail(new Error("Invalid browser response."));
      return;
    }
    const parsed = Envelope.safeParse(json);
    if (!parsed.success) {
      fail(new Error("Invalid browser response."));
      return;
    }
    const message = parsed.data;
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        message.error
          ? request.reject(new Error("Browser operation failed."))
          : request.resolve(message.result);
      }
    }
    if (message.method === "Log.entryAdded") {
      const entry = z
        .object({ entry: z.object({ level: z.string(), text: z.string() }) })
        .safeParse(message.params);
      if (entry.success) add(`[${entry.data.entry.level}] ${entry.data.entry.text}`);
    }
    if (message.method === "Runtime.consoleAPICalled") {
      const entry = z
        .object({
          type: z.string(),
          args: z.array(
            z.object({ value: z.unknown().optional(), description: z.string().optional() }),
          ),
        })
        .safeParse(message.params);
      if (entry.success)
        add(
          `[${entry.data.type}] ${entry.data.args.map((arg) => (typeof arg.value === "string" || typeof arg.value === "number" || typeof arg.value === "boolean" ? String(arg.value) : (arg.description ?? "[object]"))).join(" ")}`,
        );
    }
  };
  socket.addEventListener("open", onOpen);
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onClose);
  socket.addEventListener("message", onMessage);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(() => fail(new Error("Browser observation timed out.")), 5000);
  const rpc = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  try {
    await opened;
    if (kind === "dom") {
      const document = z
        .object({ root: z.object({ nodeId: z.number() }) })
        .parse(await rpc("DOM.getDocument", { depth: 0 }));
      return z
        .object({ outerHTML: z.string() })
        .parse(await rpc("DOM.getOuterHTML", { nodeId: document.root.nodeId }))
        .outerHTML.slice(0, 120000);
    }
    await rpc("Log.enable");
    await rpc("Runtime.enable");
    await delay(100, undefined, options.signal ? { signal: options.signal } : undefined);
    return lines.length
      ? lines.join("\n").slice(-120000)
      : "No browser console entries are available.";
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", onAbort);
    socket.removeEventListener("open", onOpen);
    socket.removeEventListener("close", onClose);
    socket.removeEventListener("error", onClose);
    socket.removeEventListener("message", onMessage);
    socket.close();
  }
}
