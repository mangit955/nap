"use client";

/**
 * Subscribing a component to a session's event log.
 *
 * The server does the hard part: `/ws?sessionId=…&seq=N` replays everything after `seq` and
 * then tails live, so a reconnection is indistinguishable from a first connection. This hook's
 * whole job is to remember the right `seq`, reconnect when the socket drops, and refuse to
 * append the same event twice — a replay that overlaps by an event or two is normal and must
 * not double a message in the transcript.
 *
 * **It answers the server's `ping`.** Any frame from the client resets the server's silence
 * counter; one that never replies is closed after the heartbeat timeout, reconnects, and does
 * it again forever. The reply is the difference between a live stream and a loop.
 *
 * **It also says whether anybody is looking** — only while the page is visible, which a pong
 * cannot say because a background tab answers the heartbeat too. That is what keeps the server's
 * idle sweep from reaping the sandbox of someone reading their code or using the preview. It says
 * so the moment a socket opens and the moment the page becomes visible, not only beside the next
 * pong: the first ping is half a minute away, and someone who has just come back to a project is
 * exactly who a sweep in that half minute would otherwise take the sandbox from.
 *
 * **Events are committed in batches, never one per frame.** The server sends a frame per stored
 * event, and every commit re-runs each derivation of the whole log above this hook — so a commit
 * per frame made opening a session of N events cost N² work, and painted the transcript a piece
 * at a time. A connection's replay is held until the server's `ready` and committed in one go;
 * after that, live events are gathered for `LIVE_BATCH_MS` and committed together. What is
 * *accepted* is still decided frame by frame, on `seq`, exactly as before: batching changes when
 * an event is drawn, never whether or in what order.
 *
 * **A project this tab has seen resumes where it left off.** Given whose project it is, the hook keeps
 * the log it commits in `remembered-logs.ts`, and the next mount for that project starts from it:
 * the socket asks only for what came after the kept `seq`, and the kept events wait in the replay
 * buffer with whatever the server adds, to be committed with `ready` as one batch. So `events` and
 * `replayed` read exactly as they do after a full replay — nothing for a while, then the whole
 * log at once — and every reader that counts "new since the replay" stays right without knowing
 * a cache exists. Meanwhile the kept events are offered separately, as `remembered`, for a
 * transcript to draw.
 *
 * The socket is created through an injected factory so the reconnect curve can be tested in
 * milliseconds against a fake, with no network anywhere near the suite.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { ServerFrameSchema } from "@nap/shared/ws-protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { API_WS_URL, fetchSocketTicket, SOCKETS_NEED_TICKETS } from "../api/socket-ticket.ts";
import { type LogKey, recallLog, rememberLog } from "./remembered-logs.ts";

/**
 * What the hook needs from a socket. A real `WebSocket` satisfies this structurally, so the
 * default factory needs no cast and a fake needs no more than `extends EventTarget`.
 */
export interface StreamSocket extends EventTarget {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type CreateSocket = (url: string) => StreamSocket;

/**
 * Deterministic, with no jitter. Jitter exists to stop a crowd of clients retrying in lockstep,
 * and a session here is one browser tab; leaving it out keeps the delays assertable to the
 * millisecond. Adding it later means taking a random source as an option.
 */
/**
 * How long live events gather before they are committed — about one frame, so a burst of command
 * output costs one render per frame rather than one per line. A timer rather than
 * `requestAnimationFrame`, which a background tab stops calling: the turn's state would then stop
 * advancing in every hook that reads it, not merely stop being painted.
 */
export const LIVE_BATCH_MS = 16;
export const BACKOFF = { initialMs: 500, maxMs: 10_000, factor: 2 } as const;

export type StreamStatus = "idle" | "connecting" | "open" | "reconnecting";

export type EventStreamOptions = {
  /** No session means no connection — what the shell renders before one exists. */
  sessionId: string | undefined;
  /**
   * The signed-in person and the project the session belongs to. Given, the log is kept for this
   * tab's next visit and the last one's is drawn and resumed from — see `remembered-logs.ts`. Known
   * before the session is, which is what lets a revisit draw before the record names its session.
   *
   * Read when a subscription starts and when a batch is committed, never as a reason to
   * resubscribe: taking it away — the project turned out not to exist — stops the keeping and
   * the drawing without touching a socket that may still be live.
   */
  remember?: LogKey | undefined;
  baseUrl?: string;
  createSocket?: CreateSocket;
  /**
   * A ticket for the socket to carry, asked for before every connection — or nothing, when the
   * socket goes to the host the session cookie belongs to. See `api/socket-ticket.ts`.
   */
  fetchTicket?: FetchTicket;
};

export type FetchTicket = (sessionId: string) => Promise<string | undefined>;

export type EventStream = {
  events: StoredEvent[];
  status: StreamStatus;
  /** The highest sequence number received, and where a reconnect resumes from. */
  lastSeq: number;
  /**
   * Whether the server has said it sent everything it had.
   *
   * The distinction a caller needs and cannot otherwise make: an empty `events` is either a
   * conversation still in flight or a project nobody has typed into, and those want opposite
   * things on screen. Retained across socket retries; reset when the session changes.
   */
  replayed: boolean;
  /**
   * What this tab last saw of the project's log, to draw until the server's replay is in — or
   * `undefined` when there is none, or once anything has been committed to `events`.
   *
   * Not part of `events` on purpose: it may be minutes old, and nothing but a picture of the
   * conversation should act on it. See the module comment.
   */
  remembered: readonly StoredEvent[] | undefined;
};

const DEFAULT_BASE_URL = API_WS_URL;

/** A ticket for one session's stream, asked for only where the socket needs one. */
const DEFAULT_FETCH_TICKET: FetchTicket | undefined = SOCKETS_NEED_TICKETS
  ? (sessionId) => fetchSocketTicket(`/sessions/${encodeURIComponent(sessionId)}/stream-ticket`)
  : undefined;

export function useEventStream(options: EventStreamOptions): EventStream {
  const { sessionId, remember, baseUrl = DEFAULT_BASE_URL } = options;
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));

  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>(
    sessionId === undefined ? "idle" : "connecting",
  );
  const [lastSeq, setLastSeq] = useState(0);
  // The session whose replay finished, rather than a flag: the reset below runs in an effect, so
  // the first render with a new session would otherwise still say the *last* one was replayed —
  // and anything that takes "replayed" as "this log is complete" would take the old log for it.
  const [replayedFor, setReplayedFor] = useState<string | undefined>(undefined);
  const replayed = sessionId !== undefined && replayedFor === sessionId;
  // Read once per project rather than per render: the kept log is replaced as this mount commits,
  // and what is worth drawing meanwhile is what was kept when the visit began.
  const ownerId = remember?.ownerId;
  const projectId = remember?.projectId;
  const recalled = useMemo(
    () =>
      ownerId === undefined || projectId === undefined
        ? undefined
        : recallLog({ ownerId, projectId }),
    [ownerId, projectId],
  );
  const rememberRef = useRef(remember);
  rememberRef.current = remember;

  // Read inside callbacks that were created on an earlier render: the reconnect needs the
  // sequence number as it is *now*, not as it was when the effect ran.
  const lastSeqRef = useRef(0);
  const createSocketRef = useRef(createSocket);
  createSocketRef.current = createSocket;
  const fetchTicketRef = useRef(options.fetchTicket ?? DEFAULT_FETCH_TICKET);
  fetchTicketRef.current = options.fetchTicket ?? DEFAULT_FETCH_TICKET;

  useEffect(() => {
    if (sessionId === undefined) {
      setStatus("idle");
      return;
    }

    // A different session is a different transcript, not a continuation of this one. A log kept
    // for this project and this session is the same transcript, so it is where this one resumes.
    const startedFor = rememberRef.current;
    const kept = startedFor === undefined ? undefined : recallLog(startedFor);
    const resumeFrom = kept?.sessionId === sessionId ? kept.events : [];
    lastSeqRef.current = resumeFrom.at(-1)?.seq ?? 0;
    setEvents([]);
    setLastSeq(0);
    setReplayedFor(undefined);

    let socket: StreamSocket | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let delayMs: number = BACKOFF.initialMs;
    let abandoned = false;
    // The socket that has opened and not yet closed, if any. Distinct from `socket`, which is
    // the latest one *attempted*: sending on a socket still connecting throws, and one that has
    // dropped, with a reconnect or a ticket still pending, has nobody on the other end.
    let live: StreamSocket | undefined;

    const sayViewing = (): void => {
      if (live !== undefined && document.visibilityState === "visible")
        live.send(JSON.stringify({ type: "viewing" }));
    };
    document.addEventListener("visibilitychange", sayViewing);

    // Accepted, in order, and not yet committed. Local to this effect, so a session switch or an
    // unmount drops it along with the socket — nothing of one session can land in the next. A kept
    // log starts here, as if the server had just replayed it, so it is committed with `ready`.
    let accepted: StoredEvent[] = [...resumeFrom];
    // Everything committed to `events` by this effect, which also reset it: the same array, kept
    // here so it can be handed to the next visit without reading state.
    let committed: StoredEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    // Whether the current connection is still replaying. Each connection replays what it missed
    // and then says `ready`, a reconnect included, so this is per socket rather than per session.
    let replaying = true;

    const flush = (): void => {
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      flushTimer = undefined;
      if (accepted.length === 0) return;
      const batch = accepted;
      accepted = [];
      committed = committed.concat(batch);
      setEvents(committed);
      setLastSeq(batch[batch.length - 1]?.seq ?? 0);
      const keep = rememberRef.current;
      if (keep !== undefined) rememberLog(keep, sessionId, committed);
    };

    const connect = (): void => {
      if (abandoned) return;

      const fetchTicket = fetchTicketRef.current;
      if (fetchTicket === undefined) {
        open(undefined);
        return;
      }
      // A ticket that could not be had still opens a socket: the server refuses it, the socket
      // closes, and the retry below asks again — the recovery this hook already has.
      void fetchTicket(sessionId)
        .catch(() => undefined)
        .then((ticket) => {
          if (!abandoned) open(ticket);
        });
    };

    const open = (ticket: string | undefined): void => {
      const query = ticket === undefined ? "" : `&ticket=${encodeURIComponent(ticket)}`;
      const url = `${baseUrl}/ws?sessionId=${encodeURIComponent(sessionId)}&seq=${lastSeqRef.current}&repairOwnership=1&usageCacheSplit=1${query}`;
      const current = createSocketRef.current(url);
      socket = current;
      replaying = true;

      current.addEventListener("open", () => {
        if (abandoned) return;
        // Reset only once a connection actually opened; resetting on the attempt would turn a
        // server that refuses connections into a tight loop.
        delayMs = BACKOFF.initialMs;
        setStatus("open");
        live = current;
        sayViewing();
      });

      current.addEventListener("message", (raw) => {
        if (abandoned) return;
        const frame = readFrame(raw);
        if (frame === undefined) return;

        if (frame.type === "ping") {
          current.send(JSON.stringify({ type: "pong" }));
          if (document.visibilityState === "visible")
            current.send(JSON.stringify({ type: "viewing" }));
          return;
        }
        // The log has been delivered in full — everything the server had when this connection
        // opened. It is the only way to tell a conversation that is still arriving from one
        // that does not exist, which is the difference between a placeholder and an invitation
        // to type the first message.
        //
        // Also the end of this connection's replay, so it is where the replay is committed —
        // in the same batch as `replayed`, so nothing ever draws a log that is half there.
        if (frame.type === "ready") {
          replaying = false;
          flush();
          setReplayedFor(sessionId);
          return;
        }
        // An `error` frame is the server rejecting something this client sent — a pong, or a
        // `viewing` an older server does not know yet. Neither is worth a retry, and dropping it
        // keeps a server complaint from tearing down a working stream.
        if (frame.type !== "event") return;

        const event = frame.event;
        if (event.sessionId !== sessionId) return;
        if (event.seq <= lastSeqRef.current) return;

        lastSeqRef.current = event.seq;
        accepted.push(event);
        if (!replaying && flushTimer === undefined) flushTimer = setTimeout(flush, LIVE_BATCH_MS);
      });

      current.addEventListener("close", () => {
        if (live === current) live = undefined;
        if (abandoned) return;
        // What arrived before the drop was accepted, and the reconnect resumes after it, so it
        // must not wait on a `ready` that this socket will never send.
        flush();
        setStatus("reconnecting");
        retryTimer = setTimeout(connect, delayMs);
        delayMs = Math.min(delayMs * BACKOFF.factor, BACKOFF.maxMs);
      });

      // A socket that errors also closes, so recovery is left to the close handler; without
      // this listener the error surfaces as an unhandled event instead.
      current.addEventListener("error", () => {});
    };

    setStatus("connecting");
    connect();

    return () => {
      // Everything the connection owns goes away with the component: a pending retry that
      // outlives it reopens a socket nobody is listening to, once per navigation.
      abandoned = true;
      document.removeEventListener("visibilitychange", sayViewing);
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      accepted = [];
      socket?.close();
    };
  }, [sessionId, baseUrl]);

  const remembered =
    !replayed &&
    events.length === 0 &&
    recalled !== undefined &&
    (sessionId === undefined || sessionId === recalled.sessionId)
      ? recalled.events
      : undefined;

  return { events, status, lastSeq, replayed, remembered };
}

/** Whatever arrived, or `undefined` if it was not a frame this client understands. */
function readFrame(raw: Event) {
  const data = (raw as MessageEvent<unknown>).data;
  if (typeof data !== "string") return undefined;

  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return undefined;
  }

  const parsed = ServerFrameSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
