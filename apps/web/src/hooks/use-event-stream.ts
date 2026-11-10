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
    // The socket that has opened and not yet closed, if any. Distinct from `socket`, which is
    // the latest one *attempted*: sending on a socket still connecting throws, and one that has
    // dropped, with a reconnect or a ticket still pending, has nobody on the other end.
    let live: StreamSocket | undefined;

    const sayViewing = (): void => {
      if (live !== undefined && document.visibilityState === "visible")
        live.send(JSON.stringify({ type: "viewing" }));
    };
    document.addEventListener("visibilitychange", sayViewing);

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
        if (frame.type === "ready") {
          setReplayed(true);
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
        setLastSeq(event.seq);
        setEvents((previous) => [...previous, event]);
      });

      current.addEventListener("close", () => {
        if (live === current) live = undefined;
        if (abandoned) return;
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
