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
 * **Events are committed in batches, never one per frame.** The server sends a frame per stored
 * event, and every commit re-runs each derivation of the whole log above this hook — so a commit
 * per frame made opening a session of N events cost N² work, and painted the transcript a piece
 * at a time. A connection's replay is held until the server's `ready` and committed in one go;
 * after that, live events are gathered for `LIVE_BATCH_MS` and committed together. What is
 * *accepted* is still decided frame by frame, on `seq`, exactly as before: batching changes when
 * an event is drawn, never whether or in what order.
 *
 * The socket is created through an injected factory so the reconnect curve can be tested in
 * milliseconds against a fake, with no network anywhere near the suite.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { ServerFrameSchema } from "@nap/shared/ws-protocol";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { credentialedFetch } from "../api/credentialed-fetch.ts";

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
  baseUrl?: string;
  createSocket?: CreateSocket;
  /**
   * A ticket for the socket to carry, asked for before every connection — or nothing, when the
   * socket goes to the host the session cookie belongs to. See `DEFAULT_FETCH_TICKET`.
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
};

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_WS_URL ?? "ws://localhost:3001";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const TicketSchema = z.object({ ticket: z.string().min(1) });

/**
 * Asks the API for a stream ticket, but only where the socket needs one.
 *
 * In production the page reaches the API through its own origin, so the session cookie belongs to
 * the page's host — and Vercel does not forward WebSocket upgrades, so the socket goes to the
 * API's own host, where that cookie is never sent. The ticket is fetched over the proxied path,
 * where the cookie *is* sent, and lasts a minute. In development both are the same `localhost`
 * and the cookie reaches the socket by itself, so nothing is asked.
 *
 * Derived from the two URLs rather than configured, so the two cannot disagree.
 */
const DEFAULT_FETCH_TICKET: FetchTicket | undefined =
  new URL(API_URL).host === new URL(DEFAULT_BASE_URL).host
    ? undefined
    : async (sessionId) => {
        const response = await credentialedFetch(
          `${API_URL}/sessions/${encodeURIComponent(sessionId)}/stream-ticket`,
          { method: "POST", cache: "no-store" },
        );
        if (!response.ok) return undefined;
        return TicketSchema.parse(await response.json()).ticket;
      };

export function useEventStream(options: EventStreamOptions): EventStream {
  const { sessionId, baseUrl = DEFAULT_BASE_URL } = options;
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));

  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>(
    sessionId === undefined ? "idle" : "connecting",
  );
  const [lastSeq, setLastSeq] = useState(0);
  const [replayed, setReplayed] = useState(false);

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

    // A different session is a different transcript, not a continuation of this one.
    lastSeqRef.current = 0;
    setEvents([]);
    setLastSeq(0);
    setReplayed(false);

    let socket: StreamSocket | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let delayMs: number = BACKOFF.initialMs;
    let abandoned = false;

    // Accepted, in order, and not yet committed. Local to this effect, so a session switch or an
    // unmount drops it along with the socket — nothing of one session can land in the next.
    let accepted: StoredEvent[] = [];
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
      setEvents((previous) => previous.concat(batch));
      setLastSeq(batch[batch.length - 1]?.seq ?? 0);
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
      });

      current.addEventListener("message", (raw) => {
        if (abandoned) return;
        const frame = readFrame(raw);
        if (frame === undefined) return;

        if (frame.type === "ping") {
          current.send(JSON.stringify({ type: "pong" }));
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
          setReplayed(true);
          return;
        }
        // An `error` frame is the server rejecting something this client sent. Nothing here
        // sends anything but pongs, so there is nothing to retry — dropping it keeps a server
        // complaint from tearing down a working stream.
        if (frame.type !== "event") return;

        const event = frame.event;
        if (event.sessionId !== sessionId) return;
        if (event.seq <= lastSeqRef.current) return;

        lastSeqRef.current = event.seq;
        accepted.push(event);
        if (!replaying && flushTimer === undefined) flushTimer = setTimeout(flush, LIVE_BATCH_MS);
      });

      current.addEventListener("close", () => {
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
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      accepted = [];
      socket?.close();
    };
  }, [sessionId, baseUrl]);

  return { events, status, lastSeq, replayed };
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
