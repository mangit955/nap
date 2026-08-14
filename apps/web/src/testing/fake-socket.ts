/**
 * A socket a test can push frames into.
 *
 * Extends `EventTarget` and dispatches real events, so whatever is under test wires up its
 * listeners for real rather than against a bespoke callback protocol — and a `StreamSocket` is
 * structurally what a `WebSocket` is, so nothing here needs a cast.
 *
 * Nothing in the `web` vitest project can open a WebSocket. The alternative to this is mocking
 * the module that owns the subscription, which is how a workspace test ends up asserting against
 * its own mock instead of against the reconnect, the dedupe and the replay.
 */

import type { ClientFrame, ServerFrame } from "@nap/shared/ws-protocol";
import type { StreamSocket } from "../hooks/use-event-stream.ts";

export class FakeSocket extends EventTarget implements StreamSocket {
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    super();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.dispatchEvent(new Event("open"));
  }

  deliver(frame: ServerFrame | string): void {
    const data = typeof frame === "string" ? frame : JSON.stringify(frame);
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  /** What the browser does when the connection drops. */
  drop(code = 1006): void {
    this.closed = true;
    this.dispatchEvent(new CloseEvent("close", { code }));
  }

  get frames(): ClientFrame[] {
    return this.sent.map((raw) => JSON.parse(raw) as ClientFrame);
  }
}

/** Records every socket that was opened, in order, so "exactly one" is a countable thing. */
export function sockets() {
  const opened: FakeSocket[] = [];
  const createSocket = (url: string): StreamSocket => {
    const socket = new FakeSocket(url);
    opened.push(socket);
    return socket;
  };

  return {
    opened,
    createSocket,
    /**
     * Counts sockets opened the ordinary way as well as injected ones.
     *
     * Without this, "the workspace opens one socket" only holds for subscriptions somebody
     * remembered to wire the factory through — and a pane that subscribes for itself is written
     * `useEventStream({ sessionId })`, with no factory at all. That is the exact regression the
     * count exists to catch, and it would reach the real `WebSocket` unseen.
     */
    countGlobalToo(stub: (name: string, value: unknown) => void): void {
      // A function rather than a class: `new` on a function that returns an object yields that
      // object, and a class constructor may not return one at all.
      stub("WebSocket", function fake(url: string) {
        return createSocket(url);
      });
    },
    get latest(): FakeSocket {
      const last = opened[opened.length - 1];
      if (last === undefined) throw new Error("no socket was opened");
      return last;
    },
    seqOf(index: number): string | null {
      const socket = opened[index];
      if (socket === undefined) throw new Error(`no socket at index ${index}`);
      return new URL(socket.url).searchParams.get("seq");
    },
  };
}
