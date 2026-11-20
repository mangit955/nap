/**
 * One tab's `/ws/account` socket: "your session list changed", and a heartbeat.
 *
 * Deliberately knows nothing about WebSockets, for the reason `event-stream.ts` gives: it is handed
 * something that can `send` and `close`, which a test double and Hono's `WSContext` both are.
 *
 * It sends `ready` once the hub is hearing notices for this user, and the tab reads its list on
 * `ready`. A change committed while the socket was opening, or while a dropped one was reconnecting,
 * was announced to nobody here, and that read is what catches it.
 */

import { getLogger } from "@nap/shared/logging";
import { parseClientFrame, type SessionListFrame, WS_CLOSE } from "@nap/shared/ws-protocol";
import { DEFAULT_HEARTBEAT, type HeartbeatOptions, type StreamSocket } from "./event-stream.ts";
import type { SessionListHub } from "./session-list-hub.ts";

/** The listener is not working; the tab polls until a reconnect finds it working. */
export const SESSION_LIST_UNAVAILABLE = 1011;

export type SessionListStream = {
  /** Hand it whatever the client sent, text or not. */
  onMessage(raw: unknown): void;
  /** Releases the subscription and the heartbeat. Safe to call more than once. */
  onClose(): void;
  /** Resolves once `ready` has been sent, or the socket refused. Tests await it. */
  ready: Promise<void>;
};

export function openSessionListStream(options: {
  hub: SessionListHub;
  userId: string;
  socket: StreamSocket;
  heartbeat?: HeartbeatOptions;
}): SessionListStream {
  const { hub, userId, socket } = options;
  const heartbeat = options.heartbeat ?? DEFAULT_HEARTBEAT;
  let closed = false;
  let silentIntervals = 0;
  let unsubscribe: (() => void) | undefined;

  const send = (frame: SessionListFrame): void => {
    if (!closed) socket.send(JSON.stringify(frame));
  };

  const timer = setInterval(() => {
    if (closed) return;
    // A pod whose listener has gone deaf has stopped hearing what this socket promised to pass on.
    // Closing sends the tab back to its short timer, and its reconnect is refused until it hears.
    if (unsubscribe !== undefined && !hub.hearing()) {
      shutdown();
      socket.close(SESSION_LIST_UNAVAILABLE, "session list notices unavailable");
      return;
    }
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
    unsubscribe?.();
  }

  const ready = (async () => {
    try {
      const release = await hub.subscribe(userId, () => send({ type: "sessions.changed" }));
      if (closed) {
        release();
        return;
      }
      unsubscribe = release;
      send({ type: "ready" });
    } catch (error) {
      getLogger().warn({ err: error }, "session list notices are not being heard");
      if (closed) return;
      shutdown();
      socket.close(SESSION_LIST_UNAVAILABLE, "session list notices unavailable");
    }
  })();

  return {
    ready,
    onClose: shutdown,
    onMessage(raw: unknown): void {
      if (closed) return;
      // Any frame proves the client is alive, as on the session stream.
      silentIntervals = 0;
      const frame = parseClientFrame(raw);
      if (!frame.ok) send({ type: "error", message: frame.error.message });
    },
  };
}
