import type { NapEvent } from "@nap/shared/events";
import type { ClientFrame, ServerFrame } from "@nap/shared/ws-protocol";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKOFF, type StreamSocket, useEventStream } from "./use-event-stream.ts";

/**
 * A `.tsx` file with no JSX in it, deliberately: the `web` vitest project globs `*.test.tsx`,
 * and the same file named `.test.ts` would be collected by `unit`, which has no DOM. A test in
 * the wrong project is not collected at all.
 *
 * Everything here runs against a fake socket and fake timers, so the reconnect curve is
 * asserted in milliseconds rather than waited out.
 */

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const OTHER_SESSION = "1c8f9f2e-4d3b-4e6c-8f7a-2b3c4d5e6f70";
const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const URL_BASE = "ws://api.test";

function event(seq: number, text: string, sessionId = SESSION): NapEvent {
  return {
    type: "agent.message",
    sessionId,
    turnId: TURN,
    seq,
    createdAt: "2026-08-09T12:00:00.000Z",
    payload: { text },
  };
}

/**
 * Stands in for a real `WebSocket`. Extends `EventTarget` and dispatches real events, so the
 * hook's listener wiring is exercised rather than replaced by a bespoke callback protocol.
 */
class FakeSocket extends EventTarget implements StreamSocket {
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

/** Records every socket the hook opens, in order. */
function sockets() {
  const opened: FakeSocket[] = [];
  const createSocket = (url: string): StreamSocket => {
    const socket = new FakeSocket(url);
    opened.push(socket);
    return socket;
  };
  return {
    opened,
    createSocket,
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

function render(net: ReturnType<typeof sockets>) {
  return renderWith(net, SESSION);
}

/** Separate from `render` because a default parameter cannot express "explicitly no session". */
function renderWith(net: ReturnType<typeof sockets>, sessionId: string | undefined) {
  return renderHook(
    ({ id }: { id: string | undefined }) =>
      useEventStream({ sessionId: id, baseUrl: URL_BASE, createSocket: net.createSocket }),
    { initialProps: { id: sessionId } },
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("connecting", () => {
  it("opens the session's stream from the beginning", () => {
    const net = sockets();
    const { result } = render(net);

    const url = new URL(net.latest.url);
    expect(url.pathname).toBe("/ws");
    expect(url.searchParams.get("sessionId")).toBe(SESSION);
    expect(url.searchParams.get("seq")).toBe("0");
    expect(result.current.status).toBe("connecting");
  });

  it("reports an open connection", () => {
    const net = sockets();
    const { result } = render(net);

    act(() => net.latest.open());

    expect(result.current.status).toBe("open");
  });

  it("opens nothing without a session, and connects once one arrives", () => {
    const net = sockets();
    const { result, rerender } = renderWith(net, undefined);

    expect(net.opened).toHaveLength(0);
    expect(result.current.status).toBe("idle");

    rerender({ id: SESSION });

    expect(net.opened).toHaveLength(1);
  });

  it("collects events in the order they arrive", () => {
    const net = sockets();
    const { result } = render(net);

    act(() => {
      net.latest.open();
      net.latest.deliver({ type: "event", event: event(1, "one") });
      net.latest.deliver({ type: "event", event: event(2, "two") });
    });

    expect(result.current.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(result.current.lastSeq).toBe(2);
  });
});

describe("reconnecting", () => {
  it("resumes from the last seq it received", () => {
    // The point of the whole hook: the server replays from `seq`, so a reconnect that forgot
    // its place would either duplicate the transcript or lose the middle of it.
    vi.useFakeTimers();
    const net = sockets();
    render(net);

    act(() => {
      net.latest.open();
      net.latest.deliver({ type: "event", event: event(1, "one") });
      net.latest.deliver({ type: "event", event: event(2, "two") });
      net.latest.deliver({ type: "event", event: event(3, "three") });
      net.latest.drop();
    });
    act(() => void vi.advanceTimersByTime(BACKOFF.initialMs));

    expect(net.opened).toHaveLength(2);
    expect(net.seqOf(1)).toBe("3");
  });

  it("keeps the transcript across a reconnect and absorbs the replay overlap", () => {
    vi.useFakeTimers();
    const net = sockets();
    const { result } = render(net);

    act(() => {
      net.latest.open();
      net.latest.deliver({ type: "event", event: event(1, "one") });
      net.latest.deliver({ type: "event", event: event(2, "two") });
      net.latest.drop();
    });
    act(() => void vi.advanceTimersByTime(BACKOFF.initialMs));
    act(() => {
      net.latest.open();
      // A server replaying one event further back than needed must not double it.
      net.latest.deliver({ type: "event", event: event(2, "two") });
      net.latest.deliver({ type: "event", event: event(3, "three") });
    });

    expect(result.current.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("waits longer after each failure and then stops growing", () => {
    vi.useFakeTimers();
    const net = sockets();
    const { result } = render(net);

    const expected = [500, 1000, 2000, 4000, 8000, 10_000, 10_000];

    for (const [attempt, delay] of expected.entries()) {
      const before = net.opened.length;
      act(() => net.latest.drop());
      expect(result.current.status).toBe("reconnecting");

      // Nothing may happen early: a shorter wait than this is the bug that turns a server
      // restart into a retry storm.
      act(() => void vi.advanceTimersByTime(delay - 1));
      expect(net.opened).toHaveLength(before);

      act(() => void vi.advanceTimersByTime(1));
      expect(net.opened).toHaveLength(before + 1);
      expect(attempt).toBeLessThan(expected.length);
    }
  });

  it("caps the delay rather than growing without bound", () => {
    expect(BACKOFF.maxMs).toBe(10_000);
    expect(BACKOFF.initialMs).toBe(500);
  });

  it("starts over from the shortest delay once a connection succeeds", () => {
    vi.useFakeTimers();
    const net = sockets();
    render(net);

    // Two failures push the delay up …
    act(() => net.latest.drop());
    act(() => void vi.advanceTimersByTime(BACKOFF.initialMs));
    act(() => net.latest.drop());
    act(() => void vi.advanceTimersByTime(BACKOFF.initialMs * 2));

    // … then a connection that actually opens resets it.
    act(() => net.latest.open());
    act(() => net.latest.drop());

    const before = net.opened.length;
    act(() => void vi.advanceTimersByTime(BACKOFF.initialMs));
    expect(net.opened).toHaveLength(before + 1);
  });
});

describe("what it accepts", () => {
  it("ignores an event it has already seen", () => {
    const net = sockets();
    const { result } = render(net);

    act(() => {
      net.latest.open();
      net.latest.deliver({ type: "event", event: event(1, "one") });
      net.latest.deliver({ type: "event", event: event(2, "two") });
      net.latest.deliver({ type: "event", event: event(2, "two again") });
      net.latest.deliver({ type: "event", event: event(1, "one again") });
    });

    expect(result.current.events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("ignores an event belonging to another session", () => {
    // Nothing should route another chat's events here, but a stale socket after a session
    // switch would, and a transcript with someone else's messages in it is worse than a gap.
    const net = sockets();
    const { result } = render(net);

    act(() => {
      net.latest.open();
      net.latest.deliver({ type: "event", event: event(1, "mine") });
      net.latest.deliver({ type: "event", event: event(2, "theirs", OTHER_SESSION) });
    });

    expect(result.current.events.map((e) => e.payload)).toEqual([{ text: "mine" }]);
  });

  it("survives a frame it cannot parse and one it can but does not carry an event", () => {
    const net = sockets();
    const { result } = render(net);

    act(() => {
      net.latest.open();
      net.latest.deliver("not json");
      net.latest.deliver('{"type":"unknown"}');
      net.latest.deliver({ type: "error", message: "seq: must be a non-negative integer" });
      net.latest.deliver({ type: "event", event: event(1, "still working") });
    });

    expect(result.current.events.map((e) => e.seq)).toEqual([1]);
    expect(result.current.status).toBe("open");
    expect(net.latest.closed).toBe(false);
  });
});

describe("heartbeat", () => {
  it("answers a ping, or the server hangs up", () => {
    // The server closes a connection that has sent nothing for its timeout window. Without
    // this reply the stream dies every two and a half minutes and reconnects forever.
    const net = sockets();
    render(net);

    act(() => {
      net.latest.open();
      net.latest.deliver({ type: "ping" });
    });

    expect(net.latest.frames).toEqual([{ type: "pong" }]);
  });

  it("says nothing in reply to an event", () => {
    const net = sockets();
    render(net);

    act(() => {
      net.latest.open();
      net.latest.deliver({ type: "event", event: event(1, "one") });
    });

    expect(net.latest.sent).toEqual([]);
  });
});

describe("unmounting", () => {
  it("closes the socket", () => {
    const net = sockets();
    const { unmount } = render(net);
    act(() => net.latest.open());

    unmount();

    expect(net.latest.closed).toBe(true);
  });

  it("does not reconnect afterwards", () => {
    // A timer that outlives the component reopens a socket nothing is listening to, once per
    // navigation.
    vi.useFakeTimers();
    const net = sockets();
    const { unmount } = render(net);

    act(() => net.latest.drop());
    unmount();
    act(() => void vi.advanceTimersByTime(BACKOFF.maxMs * 3));

    expect(net.opened).toHaveLength(1);
  });

  it("reconnects to the new session when the session changes", () => {
    const net = sockets();
    const { rerender } = render(net);
    act(() => net.latest.open());

    rerender({ id: OTHER_SESSION });

    expect(net.opened).toHaveLength(2);
    expect(net.opened[0]?.closed).toBe(true);
    expect(new URL(net.latest.url).searchParams.get("sessionId")).toBe(OTHER_SESSION);
    // A new session starts from the beginning of its own transcript.
    expect(net.seqOf(1)).toBe("0");
  });
});

describe("knowing the log has all arrived", () => {
  it("starts out not knowing", () => {
    // Everything above this hook has to be able to tell "no events yet" from "no events" —
    // and until the server says so, it cannot.
    const net = sockets();
    const { result } = render(net);
    act(() => net.latest.open());

    expect(result.current.replayed).toBe(false);
  });

  it("knows once the server says so", () => {
    const net = sockets();
    const { result } = render(net);
    act(() => net.latest.open());

    act(() => net.latest.deliver({ type: "ready" }));

    expect(result.current.replayed).toBe(true);
  });

  it("keeps knowing across a dropped connection", () => {
    // A reconnect resumes from `seq` rather than starting over, so what has already been
    // delivered stays delivered. Forgetting here would put a placeholder over a transcript the
    // client is still holding, every time a laptop lid closed.
    vi.useFakeTimers();
    const net = sockets();
    const { result } = render(net);
    act(() => net.latest.open());
    act(() => net.latest.deliver({ type: "ready" }));

    act(() => net.latest.drop());

    expect(result.current.replayed).toBe(true);
  });

  it("forgets it when the session changes", () => {
    // A different session is a different transcript, and its log has not been delivered at all.
    const net = sockets();
    const { result, rerender } = renderWith(net, SESSION);
    act(() => net.latest.open());
    act(() => net.latest.deliver({ type: "ready" }));

    rerender({ id: "8f7e6d5c-4b3a-4291-8776-5544332211ff" });

    expect(result.current.replayed).toBe(false);
  });
});
