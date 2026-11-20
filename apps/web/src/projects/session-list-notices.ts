/**
 * The tab's one `/ws/account` socket: the server saying "your session list changed".
 *
 * The session list used to be read every ten seconds in case something had changed. Now the API
 * announces every write a session card draws — a turn queued, started or finished, a pull request,
 * a rename, a shelf change in another browser — and this socket hears it, so a list can read again
 * within a second of the change and not at all while nothing happens. A notice carries no rows; the
 * list answers it with the same `GET /sessions` it always made.
 *
 * **One socket per tab, however many lists are mounted.** The sidebar, the dashboard and the
 * archive page each read the list; they share this, which opens on the first subscriber and closes
 * a few seconds after the last, so a signed-out page soon holds no socket for the person who just
 * left.
 *
 * **It says when it can be trusted.** `live` is announced once the server is hearing notices for
 * this user (its `ready` frame), on every reconnect too, and a list reads on it to catch whatever
 * changed while nobody was listening. `down` is announced when the socket drops, and a list goes
 * back to reading on a timer until the next `live`. An older API with no `/ws/account` simply
 * never says `live`, so the list keeps the timer it had.
 */

import { SessionListFrameSchema } from "@nap/shared/ws-protocol";
import { API_WS_URL, fetchSocketTicket, SOCKETS_NEED_TICKETS } from "../api/socket-ticket.ts";
import type { CreateSocket, StreamSocket } from "../hooks/use-event-stream.ts";

export type SessionListNotice = "live" | "changed" | "down";
export type SessionListNoticeListener = (notice: SessionListNotice) => void;

export type SessionListNotices = {
  /** Starts listening on the first subscriber and stops with the last. Idempotent unsubscribe. */
  subscribe(listener: SessionListNoticeListener): () => void;
  /**
   * Closes the socket now, lingering or not, and forgets every list on it. The socket belongs to
   * whoever opened it: after a sign-out, the next person's lists must not inherit it.
   */
  close(): void;
  /** Whether notices are reaching this tab right now. */
  live(): boolean;
};

/**
 * Slower than a session stream's, because nothing here is being watched scroll by: a list that
 * cannot hear notices is reading on its timer meanwhile, and an API with no `/ws/account` would
 * otherwise be asked for a ticket and a socket every ten seconds for ever.
 */
export const NOTICE_BACKOFF = { initialMs: 1000, maxMs: 60_000, factor: 2 } as const;

/**
 * How long a notice waits for the ones behind it. A turn's claim and its first events, or a move
 * that rewrites several rows, arrive as a burst, and one read answers all of them.
 */
export const NOTICE_COALESCE_MS = 100;

/**
 * How long a socket may say nothing before it is taken for dead. The server pings every thirty
 * seconds; a laptop that slept, or a network that changed under it, leaves a socket that never
 * closes and never delivers, and `live` would otherwise stay true over it.
 */
export const NOTICE_SILENCE_MS = 75_000;

/**
 * How long the socket outlives the last list. The dashboard and a project's sidebar are never
 * mounted together, so moving between them would otherwise cost a ticket, an upgrade and a read
 * every time.
 */
export const NOTICE_LINGER_MS = 5_000;

export function createSessionListNotices({
  createSocket = (url) => new WebSocket(url),
  fetchTicket = SOCKETS_NEED_TICKETS
    ? () => fetchSocketTicket("/account/stream-ticket")
    : undefined,
  baseUrl = API_WS_URL,
  random = Math.random,
}: {
  createSocket?: CreateSocket;
  /** Absent, the socket carries no ticket and the cookie authenticates it. */
  fetchTicket?: (() => Promise<string | undefined>) | undefined;
  baseUrl?: string;
  /**
   * Spreads reconnects: every tab on a pod that is drained reconnects at once otherwise, and each
   * reads the list on `ready`.
   */
  random?: () => number;
} = {}): SessionListNotices {
  const listeners = new Set<SessionListNoticeListener>();
  let socket: StreamSocket | undefined;
  let isLive = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  let silenceTimer: ReturnType<typeof setInterval> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let delayMs: number = NOTICE_BACKOFF.initialMs;
  /** Moves on every stop, so a ticket or a socket from before it is ignored. */
  let generation = 0;

  const emit = (notice: SessionListNotice): void => {
    for (const listener of [...listeners]) listener(notice);
  };

  const open = (ticket: string | undefined, version: number): void => {
    if (version !== generation) return;
    const query = ticket === undefined ? "" : `?ticket=${encodeURIComponent(ticket)}`;
    const current = createSocket(`${baseUrl}/ws/account${query}`);
    socket = current;
    let heardAt = Date.now();

    /** The connection is over, however that was learned. Once per socket. */
    const dropped = (): void => {
      if (socket !== current) return;
      socket = undefined;
      clearInterval(silenceTimer);
      silenceTimer = undefined;
      const wasLive = isLive;
      isLive = false;
      if (wasLive) emit("down");
      retryTimer = setTimeout(() => connect(version), delayMs * (0.5 + random() / 2));
      delayMs = Math.min(delayMs * NOTICE_BACKOFF.factor, NOTICE_BACKOFF.maxMs);
    };

    clearInterval(silenceTimer);
    silenceTimer = setInterval(() => {
      if (Date.now() - heardAt < NOTICE_SILENCE_MS) return;
      dropped();
      current.close();
    }, NOTICE_SILENCE_MS / 5);

    current.addEventListener("message", (raw) => {
      if (socket !== current) return;
      heardAt = Date.now();
      const frame = readFrame(raw);
      if (frame === undefined) return;
      if (frame.type === "ping") {
        current.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (frame.type === "ready") {
        // Reset only once the server is actually hearing for us; resetting on an open would turn
        // a server that accepts and then refuses into a tight loop.
        delayMs = NOTICE_BACKOFF.initialMs;
        isLive = true;
        emit("live");
        return;
      }
      if (frame.type === "sessions.changed" && coalesceTimer === undefined) {
        coalesceTimer = setTimeout(() => {
          coalesceTimer = undefined;
          emit("changed");
        }, NOTICE_COALESCE_MS);
      }
    });

    current.addEventListener("close", dropped);
    // A socket that errors also closes; recovery is the close handler's.
    current.addEventListener("error", () => {});
  };

  const connect = (version: number): void => {
    retryTimer = undefined;
    if (version !== generation) return;
    if (fetchTicket === undefined) {
      open(undefined, version);
      return;
    }
    // A ticket that could not be had still opens a socket: the server refuses it, the socket
    // closes, and the retry asks again.
    void fetchTicket()
      .catch(() => undefined)
      .then((ticket) => open(ticket, version));
  };

  const stop = (): void => {
    running = false;
    stopTimer = undefined;
    generation += 1;
    clearTimeout(retryTimer);
    clearTimeout(coalesceTimer);
    clearInterval(silenceTimer);
    retryTimer = undefined;
    coalesceTimer = undefined;
    silenceTimer = undefined;
    isLive = false;
    delayMs = NOTICE_BACKOFF.initialMs;
    const current = socket;
    socket = undefined;
    current?.close();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      clearTimeout(stopTimer);
      stopTimer = undefined;
      if (!running) {
        running = true;
        connect(generation);
      }
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) stopTimer = setTimeout(stop, NOTICE_LINGER_MS);
      };
    },
    close() {
      listeners.clear();
      clearTimeout(stopTimer);
      if (running) stop();
    },
    live: () => isLive,
  };
}

function readFrame(raw: Event) {
  if (!(raw instanceof MessageEvent) || typeof raw.data !== "string") return undefined;
  try {
    const parsed = SessionListFrameSchema.safeParse(JSON.parse(raw.data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

let shared: SessionListNotices | undefined;

/** The tab's own, created on first use. */
export function sessionListNotices(): SessionListNotices {
  shared ??= createSessionListNotices();
  return shared;
}

/** Closes the tab's own on sign-out (`auth/forget-signed-out.ts`); the next list opens another. */
export function forgetSessionListNotices(): void {
  shared?.close();
  shared = undefined;
}
