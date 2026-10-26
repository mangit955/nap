/**
 * The desktop browser's only debugger endpoint: a Unix socket in the private desktop state
 * directory, bridged to Chrome's `--remote-debugging-pipe`. An E2B diagnostic found a second
 * listener beside Chrome's on 9222, with no holder visible to the desktop user. Its envd
 * attribution and precise forwarding mechanism are inferred; public DevTools exposure was
 * not measured. A Unix socket removes TCP debugging without relying on that mechanism.
 * See docs/adr/0019-the-desktop-debugger-has-no-port.md.
 */
import { spawn } from "node:child_process";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { Duplex } from "node:stream";
import { z } from "zod";

/** Room for a DOM read well beyond what an observation accepts, which then refuses it itself. */
export const BROWSER_FRAME_LIMIT_BYTES = 16 * 1024 * 1024;
/** Desktop clients send short fixed commands; nothing they need comes near this. */
export const CLIENT_FRAME_LIMIT_BYTES = 64 * 1024;
/** Each desktop operation is one short-lived process, so this many at once means a leak. */
export const BRIDGE_CLIENT_LIMIT = 16;
/** Pending requests and owned sessions share a budget so cleanup always has a slot. */
const BRIDGE_STATE_LIMIT = 64;
/** Chrome's graceful shutdown normally takes well under a second. */
const BROWSER_STOP_GRACE_MS = 10_000;

/**
 * Splits a byte stream into NUL-terminated frames. A NUL byte cannot occur inside a UTF-8
 * multi-byte sequence or inside JSON text, so each complete frame decodes on its own. An
 * oversized frame is discarded through its terminator, never passed on in part.
 */
export class NulFrames {
  readonly #limit: number;
  #chunks: Buffer[] = [];
  #size = 0;
  #discarding = false;
  constructor(limit: number) {
    this.#limit = limit;
  }
  push(chunk: Buffer): { frames: string[]; overflow: boolean } {
    const frames: string[] = [];
    let overflow = false;
    let rest = chunk;
    while (rest.length) {
      const end = rest.indexOf(0);
      const part = end < 0 ? rest : rest.subarray(0, end);
      rest = end < 0 ? Buffer.alloc(0) : rest.subarray(end + 1);
      if (!this.#discarding) {
        this.#chunks.push(part);
        this.#size += part.length;
        if (this.#size > this.#limit) {
          overflow = true;
          this.#discarding = true;
          this.#chunks = [];
          this.#size = 0;
        }
      }
      if (end < 0) break;
      if (!this.#discarding) frames.push(Buffer.concat(this.#chunks).toString("utf8"));
      this.#discarding = false;
      this.#chunks = [];
      this.#size = 0;
    }
    return { frames, overflow };
  }
}

const ClientMessage = z.strictObject({
  id: z.int().nonnegative(),
  method: z.string().min(1).max(200),
  params: z.record(z.string(), z.unknown()).optional(),
  sessionId: z.string().min(1).max(200).optional(),
});
const BrowserMessage = z.looseObject({
  id: z.int().optional(),
  method: z.string().optional(),
  sessionId: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
const SessionParams = z.looseObject({ sessionId: z.string().min(1) });

export type CdpClient = { send(frame: string): void };
type Pending = {
  client: CdpClient | undefined;
  id: number;
  method: string;
  sessionParam: string | undefined;
};

/**
 * Chrome holds one debugger connection — the pipe — however many desktop processes ask it
 * something. Rewriting request ids keeps their replies apart, and owning each flat session
 * by the client that attached it keeps their events apart. A client that disconnects,
 * however it ends, leaves nothing attached behind it.
 */
export class CdpRouter {
  readonly #browser: (frame: string) => void;
  readonly #clients = new Set<CdpClient>();
  readonly #pending = new Map<number, Pending>();
  readonly #owners = new Map<string, CdpClient>();
  #nextId = 0;
  constructor(sendToBrowser: (frame: string) => void) {
    this.#browser = sendToBrowser;
  }
  connect(client: CdpClient): void {
    this.#clients.add(client);
  }
  /** False for an invalid frame or exhausted request budget; the caller drops that client. */
  fromClient(client: CdpClient, frame: string): boolean {
    if (!this.#clients.has(client)) return false;
    let json: unknown;
    try {
      json = JSON.parse(frame);
    } catch {
      return false;
    }
    const parsed = ClientMessage.safeParse(json);
    if (!parsed.success) return false;
    const message = parsed.data;
    if (message.sessionId !== undefined && this.#owners.get(message.sessionId) !== client)
      return false;
    let sessionParam: string | undefined;
    if (message.method === "Target.detachFromTarget") {
      const params = SessionParams.safeParse(message.params);
      if (!params.success || this.#owners.get(params.data.sessionId) !== client) return false;
      sessionParam = params.data.sessionId;
    }
    if (this.#pending.size + this.#owners.size >= BRIDGE_STATE_LIMIT) return false;
    const id = ++this.#nextId;
    this.#pending.set(id, { client, id: message.id, method: message.method, sessionParam });
    this.#browser(JSON.stringify({ ...message, id }));
    return true;
  }
  fromBrowser(frame: string): void {
    let json: unknown;
    try {
      json = JSON.parse(frame);
    } catch {
      return;
    }
    const parsed = BrowserMessage.safeParse(json);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.id !== undefined) {
      const request = this.#pending.get(message.id);
      if (!request) return;
      this.#pending.delete(message.id);
      const live = request.client !== undefined && this.#clients.has(request.client);
      if (request.method === "Target.attachToTarget") {
        const attached = SessionParams.safeParse(message.result);
        if (attached.success) {
          if (live && request.client) this.#owners.set(attached.data.sessionId, request.client);
          else this.#detach(attached.data.sessionId);
        }
      }
      if (request.method === "Target.detachFromTarget" && request.sessionParam && !message.error)
        this.#owners.delete(request.sessionParam);
      if (live && request.client)
        request.client.send(JSON.stringify({ ...message, id: request.id }));
      return;
    }
    if (message.sessionId !== undefined) {
      this.#owners.get(message.sessionId)?.send(frame);
      return;
    }
    // Browser-level events reach a client only when they concern a session it owns.
    const about = SessionParams.safeParse(message.params);
    if (!about.success) return;
    const owner = this.#owners.get(about.data.sessionId);
    if (message.method === "Target.detachedFromTarget") this.#owners.delete(about.data.sessionId);
    owner?.send(frame);
  }
  disconnect(client: CdpClient): void {
    this.#clients.delete(client);
    for (const [id, request] of this.#pending)
      if (request.client === client) {
        // A late attach still needs cleanup, but must not retain the client's socket.
        if (request.method === "Target.attachToTarget")
          this.#pending.set(id, { ...request, client: undefined });
        else this.#pending.delete(id);
      }
    for (const [sessionId, owner] of this.#owners)
      if (owner === client) {
        this.#owners.delete(sessionId);
        this.#detach(sessionId);
      }
  }
  #detach(sessionId: string): void {
    const id = ++this.#nextId;
    this.#pending.set(id, {
      client: undefined,
      id,
      method: "Target.detachFromTarget",
      sessionParam: sessionId,
    });
    this.#browser(JSON.stringify({ id, method: "Target.detachFromTarget", params: { sessionId } }));
  }
}

function duplex(stream: unknown): Duplex {
  if (stream instanceof Duplex) return stream;
  throw new Error("The browser pipe is unavailable.");
}

async function claimSocketPath(path: string): Promise<void> {
  try {
    if (!lstatSync(path).isSocket()) throw new Error("The debugger path is not a socket.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // Only a socket nobody answers on is stale. A live one may be another desktop's browser.
  const live = await new Promise<boolean>((resolve) => {
    const probe = createConnection(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
  if (live) throw new Error("The debugger socket is already in use.");
  unlinkSync(path);
}

async function listen(server: Server, path: string): Promise<void> {
  // Created owner-only: no window exists in which another user could connect.
  const previous = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } finally {
    process.umask(previous);
  }
  chmodSync(path, 0o600);
}

/**
 * Serves the socket, launches the browser with the pipe, and lives exactly as long as it.
 * Stopping sends the browser SIGTERM and waits for it to exit — killing only that child,
 * after a grace period — so whoever stopped the bridge knows the profile is free once the
 * bridge itself is gone.
 */
export async function runCdpBridge(options: {
  socketPath: string;
  command: string;
  args: readonly string[];
  stopGraceMs?: number;
  stop?: AbortSignal;
}): Promise<number> {
  await claimSocketPath(options.socketPath);
  const server = createServer();
  await listen(server, options.socketPath);
  const inode = lstatSync(options.socketPath).ino;
  const connections = new Set<Socket>();
  let escalation: NodeJS.Timeout | undefined;
  try {
    // Chrome's pipe contract (`--remote-debugging-pipe`, as Puppeteer and Playwright launch
    // it): Chrome reads commands from descriptor 3 and writes replies and events to
    // descriptor 4, each message one JSON text terminated by a NUL byte. Chrome exits when
    // descriptor 3 reaches end of file, so a bridge that dies, however it dies, takes its
    // browser with it.
    const browser = spawn(options.command, [...options.args], {
      stdio: ["ignore", "inherit", "inherit", "pipe", "pipe"],
    });
    const exited = new Promise<number>((resolve) => {
      browser.once("error", () => resolve(1));
      browser.once("exit", (exitCode) => resolve(exitCode ?? 1));
    });
    const toBrowser = duplex(browser.stdio[3]);
    const fromBrowser = duplex(browser.stdio[4]);
    toBrowser.on("error", () => {});
    fromBrowser.on("error", () => {});
    const router = new CdpRouter((frame) => {
      if (!toBrowser.destroyed) toBrowser.write(`${frame}\0`);
    });
    const browserFrames = new NulFrames(BROWSER_FRAME_LIMIT_BYTES);
    fromBrowser.on("data", (chunk: Buffer) => {
      // An oversized frame is dropped; its requester's own deadline reports the failure.
      for (const frame of browserFrames.push(chunk).frames) router.fromBrowser(frame);
    });
    server.on("connection", (connection) => {
      if (connections.size >= BRIDGE_CLIENT_LIMIT) {
        connection.destroy();
        return;
      }
      connections.add(connection);
      const client: CdpClient = {
        send(frame) {
          if (connection.destroyed) return;
          connection.write(`${frame}\0`);
          // A client that stops reading must not hold the bridge's memory.
          if (connection.writableLength > 2 * BROWSER_FRAME_LIMIT_BYTES) connection.destroy();
        },
      };
      router.connect(client);
      const frames = new NulFrames(CLIENT_FRAME_LIMIT_BYTES);
      connection.on("data", (chunk: Buffer) => {
        const read = frames.push(chunk);
        if (read.overflow) connection.destroy();
        for (const frame of read.frames)
          if (connection.destroyed || !router.fromClient(client, frame)) {
            connection.destroy();
            break;
          }
      });
      connection.on("error", () => {});
      connection.on("close", () => {
        connections.delete(connection);
        router.disconnect(client);
      });
    });
    const stop = () => {
      if (browser.exitCode !== null || browser.signalCode !== null) return;
      browser.kill("SIGTERM");
      escalation ??= setTimeout(() => {
        // Still unreaped, so this PID is still that browser and nothing else.
        if (browser.exitCode === null && browser.signalCode === null) browser.kill("SIGKILL");
      }, options.stopGraceMs ?? BROWSER_STOP_GRACE_MS);
    };
    options.stop?.addEventListener("abort", stop, { once: true });
    if (options.stop?.aborted) stop();
    try {
      return await exited;
    } finally {
      options.stop?.removeEventListener("abort", stop);
      toBrowser.destroy();
      fromBrowser.destroy();
    }
  } finally {
    clearTimeout(escalation);
    for (const connection of connections) connection.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      if (lstatSync(options.socketPath).ino === inode) unlinkSync(options.socketPath);
    } catch {
      // Closing the server has already removed it.
    }
  }
}

export type CdpSocket = EventTarget & { send(message: string): void; close(): void };

/**
 * A client end of the bridge as events: `open`, one `message` per frame, `overflow` when a
 * frame exceeded `maxFrameBytes` and was dropped, then `error` and `close`.
 */
export function openCdpSocket(path: string, maxFrameBytes: number): CdpSocket {
  const target = new EventTarget();
  const frames = new NulFrames(maxFrameBytes);
  const connection = createConnection(path);
  connection.on("connect", () => target.dispatchEvent(new Event("open")));
  connection.on("data", (chunk: Buffer) => {
    const read = frames.push(chunk);
    for (const data of read.frames) target.dispatchEvent(new MessageEvent("message", { data }));
    if (read.overflow) target.dispatchEvent(new Event("overflow"));
  });
  connection.on("error", () => target.dispatchEvent(new Event("error")));
  connection.on("close", () => target.dispatchEvent(new Event("close")));
  return Object.assign(target, {
    send(message: string) {
      if (!connection.destroyed) connection.write(`${message}\0`);
    },
    close() {
      connection.destroy();
    },
  });
}

const VersionReply = z.object({
  id: z.literal(1),
  result: z.object({ product: z.string().min(1) }),
});

/** Whether a browser answers through the bridge: one Browser.getVersion round trip. */
export async function probeCdpBridge(path: string, timeoutMs = 1000): Promise<boolean> {
  const socket = openCdpSocket(path, 64 * 1024);
  try {
    return await new Promise<boolean>((resolve) => {
      const deadline = setTimeout(() => resolve(false), timeoutMs);
      const settle = (value: boolean) => {
        clearTimeout(deadline);
        resolve(value);
      };
      socket.addEventListener("open", () =>
        socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" })),
      );
      socket.addEventListener("message", (event) => {
        if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
        try {
          settle(VersionReply.safeParse(JSON.parse(event.data)).success);
        } catch {
          settle(false);
        }
      });
      for (const name of ["overflow", "error", "close"])
        socket.addEventListener(name, () => settle(false));
    });
  } finally {
    socket.close();
  }
}

/**
 * The driver's two private modes, dispatched before its ordinary request handling:
 * `--cdp-bridge <socket> -- <browser command...>` and `--cdp-probe <socket>`. Returns the
 * process exit code; 2 is a malformed invocation that started nothing.
 */
export async function runCdpMode(argv: readonly string[]): Promise<number> {
  const [mode, path, separator, command, ...args] = argv;
  if (!path || !isAbsolute(path)) return 2;
  if (mode === "--cdp-probe") return argv.length === 2 ? ((await probeCdpBridge(path)) ? 0 : 1) : 2;
  if (mode !== "--cdp-bridge" || separator !== "--" || !command) return 2;
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.on("SIGTERM", abort);
  process.on("SIGINT", abort);
  try {
    return await runCdpBridge({ socketPath: path, command, args, stop: stop.signal });
  } catch (error) {
    console.error(`Browser debugger bridge: ${error instanceof Error ? error.message : error}`);
    return 1;
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}
