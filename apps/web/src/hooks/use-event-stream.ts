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
 * The socket is created through an injected factory so the reconnect curve can be tested in
 * milliseconds against a fake, with no network anywhere near the suite.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { ServerFrameSchema } from "@nap/shared/ws-protocol";
import { useEffect, useRef, useState } from "react";

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
};

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
   * things on screen. False again from the moment a new connection is opened.
   */
  replayed: boolean;
};

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_WS_URL ?? "ws://localhost:3001";

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

    const connect = (): void => {
      if (abandoned) return;

      const url = `${baseUrl}/ws?sessionId=${encodeURIComponent(sessionId)}&seq=${lastSeqRef.current}`;
      const current = createSocketRef.current(url);
      socket = current;

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
        if (frame.type === "ready") {
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
        setLastSeq(event.seq);
        setEvents((previous) => [...previous, event]);
      });

      current.addEventListener("close", () => {
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
