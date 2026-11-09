/**
 * One client's view of one session's event log: replay what it missed, then tail.
 *
 * **Subscribe first, then read.** The obvious order — read the history, then start
 * listening — loses everything appended in between, which is precisely the window a client
 * connecting mid-turn lands in. So this subscribes, buffers whatever arrives, awaits the
 * history, sends it, flushes the buffer, and only then goes live. The flush is synchronous
 * and the bus delivers synchronously, so nothing can interleave with it; the read is the
 * only await in the whole opening sequence.
 *
 * **Nothing is sent twice.** Every outbound event passes one gate on the highest `seq`
 * already sent, so "the replay and the buffer overlap" needs no special case and a
 * republished event cannot become a doubled message in someone's chat.
 *
 * Deliberately knows nothing about WebSockets: it is given something that can `send` text
 * and `close`, which both a test double and Hono's `WSContext` satisfy. The socket is the
 * part that cannot run under Node, and keeping it out of here is what lets the replay
 * ordering be tested at all.
 */

import type { NapEvent } from "@nap/shared/events";
import type { EventBus, Unsubscribe } from "@nap/shared/ports/event-bus";
import type { EventStore, StoredEvent } from "@nap/shared/ports/event-store";
import { parseClientFrame, type ServerFrame, WS_CLOSE } from "@nap/shared/ws-protocol";

/** The two things this needs from a socket. */
export type StreamSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type HeartbeatOptions = {
  /** How often to ping, and the granularity at which silence is measured. */
  intervalMs: number;
  /** Silence longer than this closes the connection. */
  timeoutMs: number;
};

/**
 * A dead TCP connection can stay open for minutes; a ping every 30 seconds finds it in one,
 * and a client that has answered nothing for two and a half minutes is gone.
 */
export const DEFAULT_HEARTBEAT: HeartbeatOptions = { intervalMs: 30_000, timeoutMs: 150_000 };

export type EventStreamOptions = {
  store: EventStore;
  bus: EventBus;
  sessionId: string;
  /** Send events after this sequence number. */
  afterSeq: number;
  /** Old open tabs use strict prompt schemas. Full ownership is explicit opt-in. */
  repairOwnership?: boolean;
  /**
   * Old open tabs parse usage as exactly `{ inputTokens, outputTokens }`, so the cache split is
   * sent only to a socket that asked for it. See `docs/DEPLOY.md`, "Usage cache split rollout".
   */
  usageCacheSplit?: boolean;
  socket: StreamSocket;
  heartbeat?: HeartbeatOptions;
};

export type EventStream = {
  /** Hand it whatever the client sent, text or not. */
  onMessage(raw: unknown): void;
  /** Releases the subscription and the heartbeat. Safe to call more than once. */
  onClose(): void;
  /** Resolves once the replay has been delivered. Tests await it; the socket does not. */
  ready: Promise<void>;
};

export function openEventStream(options: EventStreamOptions): EventStream {
  const { store, bus, sessionId, afterSeq, socket } = options;
  const heartbeat = options.heartbeat ?? DEFAULT_HEARTBEAT;

  let lastSentSeq = afterSeq;
  let sentAnything = false;
  let closed = false;
  let replaying = true;
  const buffered: StoredEvent[] = [];
  let silentIntervals = 0;

  const send = (frame: ServerFrame): void => {
    if (closed) return;
    socket.send(JSON.stringify(frame));
  };

  const sendEvent = (event: StoredEvent): void => {
    // The one gate that makes "no duplicates" structural rather than a rule each path has
    // to remember. Ordering is guaranteed by seq being gapless per session.
    //
    // The first event is never gated, because a client cannot have seen an event that does
    // not exist: one that asks for a seq past the end of the log — a stale reconnect, or a
    // reset database — would otherwise be silenced for the life of the connection, which
    // looks exactly like a working stream with nothing happening.
    if (sentAnything && event.seq <= lastSentSeq) return;
    sentAnything = true;
    lastSentSeq = event.seq;
    let outgoing: StoredEvent = event;
    if (
      !options.repairOwnership &&
      outgoing.type === "user.message" &&
      outgoing.payload.repair !== undefined
    ) {
      const { repair: _repair, ...payload } = outgoing.payload;
      outgoing = { ...outgoing, payload };
    }
    if (!options.usageCacheSplit) outgoing = withoutCacheSplit(outgoing);
    send({ type: "event", event: outgoing });
  };

  const unsubscribe: Unsubscribe = bus.subscribe(sessionId, (event) => {
    if (closed) return;
    if (replaying) {
      buffered.push(event);
      return;
    }
    sendEvent(event);
  });

  const timer = setInterval(() => {
    if (closed) return;
    silentIntervals += 1;
    if (silentIntervals * heartbeat.intervalMs >= heartbeat.timeoutMs) {
      shutdown();
      socket.close(WS_CLOSE.heartbeatTimeout, "no frames received");
      return;
    }
    send({ type: "ping" });
  }, heartbeat.intervalMs);

  function shutdown(): void {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    unsubscribe();
  }

  const ready = (async () => {
    const history = await store.readFrom(sessionId, afterSeq);
    if (closed) return;

    for (const event of history) sendEvent(event);
    // Anything the turn produced while that query was in flight. Synchronous, so no event
    // can arrive between the last flushed one and going live.
    for (const event of buffered) sendEvent(event);
    buffered.length = 0;
    replaying = false;

    // Only now, because "ready" means the client has everything up to this moment — including
    // whatever was appended while the history query was in flight. Announced at all because
    // "connected and nothing has arrived" is otherwise two different situations wearing one
    // face: a conversation still on its way, and a project nobody has typed into yet.
    send({ type: "ready" });
  })();

  return {
    ready,
    onClose: shutdown,
    onMessage(raw: unknown): void {
      if (closed) return;
      // Any frame at all proves the client is alive — waiting specifically for a pong would
      // close a connection whose client is chatty but never answers the heartbeat.
      silentIntervals = 0;

      const frame = parseClientFrame(raw);
      // Advisory, not fatal: a client bug should cost it an error frame, not its transcript.
      if (!frame.ok) send({ type: "error", message: frame.error.message });
    },
  };
}

/** Every event type whose payload carries usage. */
// Matches an event whose payload has a `usage` key at all, optional or not: `Extract` against
// `{ usage: unknown }` skips an optional one, and optional is how events usually grow a field.
// Empty payloads have `keyof` = `string`, which would otherwise match every key name.
type UsageEventType = NapEvent extends infer E
  ? E extends { type: infer T; payload: infer P }
    ? string extends keyof P
      ? never
      : "usage" extends keyof P
        ? T
        : never
    : never
  : never;

/**
 * Keyed by every one of them, so an event that gains a `usage` compiles only once it is listed
 * here — and an old tab is never sent a cache split through an event nobody remembered.
 */
const USAGE_EVENTS: Record<UsageEventType, true> = {
  "turn.completed": true,
  "subagent.completed": true,
  "compaction.completed": true,
  "compaction.failed": true,
  "project.renamed": true,
};

function carriesUsage(event: StoredEvent): event is Extract<StoredEvent, { type: UsageEventType }> {
  return Object.hasOwn(USAGE_EVENTS, event.type);
}

/** The event as a reader from before the cache split parses it: usage with only its two totals. */
function withoutCacheSplit(event: StoredEvent): StoredEvent {
  if (!carriesUsage(event) || event.payload.usage == null) return event;
  const { inputTokens, outputTokens } = event.payload.usage;
  return {
    ...event,
    payload: { ...event.payload, usage: { inputTokens, outputTokens } },
  } as StoredEvent;
}
