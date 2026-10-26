import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { type CdpSocket, openCdpSocket } from "./desktop-cdp-bridge.ts";
import { DESKTOP_CDP_SOCKET } from "./desktop-protocol.ts";

type Options = { createSocket?: () => CdpSocket; signal?: AbortSignal };
const DOM_OUTPUT_LIMIT = 120000;
const DOM_TRUNCATED = "\n[DOM truncated]";
const MESSAGE_LIMIT = 1_000_000;
// UTF-8 needs at most three bytes for each UTF-16 unit, so a frame of the accepted length
// always fits; the character check below is the one that applies.
const FRAME_LIMIT_BYTES = 3 * MESSAGE_LIMIT + 1024;

const Targets = z.object({
  targetInfos: z.array(
    z.object({ targetId: z.string().min(1), type: z.string(), url: z.string() }),
  ),
});
const Attached = z.object({ sessionId: z.string().min(1) });
const Envelope = z.object({
  id: z.number().optional(),
  sessionId: z.string().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
});

/**
 * Fixed, read-only CDP observations. There is no operation accepting page JavaScript.
 *
 * The bridge's socket is a browser-level connection, so the page is reached through a flat
 * session of its own: replies count only from the session that was asked, and events only
 * from that session.
 */
export async function observeDesktopPage(
  kind: "dom" | "console",
  options: Options = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  const socket = (
    options.createSocket ?? (() => openCdpSocket(DESKTOP_CDP_SOCKET, FRAME_LIMIT_BYTES))
  )();
  let nextId = 0;
  let sessionId: string | undefined;
  let open = false;
  const pending = new Map<
    number,
    {
      sessionId: string | undefined;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
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
  const onOpen = () => {
    open = true;
    resolveOpen();
  };
  const onClose = () =>
    fail(
      new Error(open ? "Browser observation disconnected." : "Browser debugger is unavailable."),
    );
  const onAbort = () => fail(new Error("Browser observation cancelled."));
  const onOverflow = () => fail(new Error("Browser observation is too large."));
  const onMessage = (event: Event) => {
    if (!("data" in event) || typeof event.data !== "string") return;
    if (event.data.length > MESSAGE_LIMIT) {
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
      if (request && request.sessionId === message.sessionId) {
        pending.delete(message.id);
        message.error
          ? request.reject(new Error("Browser operation failed."))
          : request.resolve(message.result);
      }
      return;
    }
    if (sessionId === undefined || message.sessionId !== sessionId) return;
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
  socket.addEventListener("overflow", onOverflow);
  socket.addEventListener("message", onMessage);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(() => fail(new Error("Browser observation timed out.")), 5000);
  const rpc = (
    method: string,
    params: Record<string, unknown> = {},
    session = sessionId,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { sessionId: session, resolve, reject });
      socket.send(
        JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }),
      );
    });
  try {
    await opened;
    const targets = Targets.parse(await rpc("Target.getTargets", {}, undefined)).targetInfos;
    // Chrome exposes omnibox and extension surfaces as page targets too.
    const page = targets.find(
      (target) =>
        target.type === "page" &&
        (/^(?:https?:|chrome-error:)/.test(target.url) || target.url === "about:blank"),
    );
    if (!page) throw new Error("No browser page is open.");
    sessionId = Attached.parse(
      await rpc("Target.attachToTarget", { targetId: page.targetId, flatten: true }, undefined),
    ).sessionId;
    if (kind === "dom") {
      const document = z
        .object({ root: z.object({ nodeId: z.number() }) })
        .parse(await rpc("DOM.getDocument", { depth: 0 }));
      // Large head scripts and styles must not consume the observation before page content.
      const body = z
        .object({ nodeId: z.int().nonnegative() })
        .parse(await rpc("DOM.querySelector", { nodeId: document.root.nodeId, selector: "body" }));
      const html = z
        .object({ outerHTML: z.string() })
        .parse(
          await rpc("DOM.getOuterHTML", { nodeId: body.nodeId || document.root.nodeId }),
        ).outerHTML;
      return html.length > DOM_OUTPUT_LIMIT
        ? html.slice(0, DOM_OUTPUT_LIMIT - DOM_TRUNCATED.length) + DOM_TRUNCATED
        : html;
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
    socket.removeEventListener("overflow", onOverflow);
    socket.removeEventListener("message", onMessage);
    // Ends the page session promptly. The bridge also detaches whatever a closed connection
    // left attached, which covers an observer killed before it reaches this line.
    if (sessionId !== undefined)
      socket.send(
        JSON.stringify({
          id: ++nextId,
          method: "Target.detachFromTarget",
          params: { sessionId },
        }),
      );
    socket.close();
  }
}
