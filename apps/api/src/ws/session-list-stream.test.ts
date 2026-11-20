import type { SessionListFrame } from "@nap/shared/ws-protocol";
import { WS_CLOSE } from "@nap/shared/ws-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionListHub } from "./session-list-hub.ts";
import { openSessionListStream, SESSION_LIST_UNAVAILABLE } from "./session-list-stream.ts";

const ALICE = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";

afterEach(() => {
  vi.useRealTimers();
});

function socket() {
  const sent: SessionListFrame[] = [];
  const closed: number[] = [];
  return {
    sent,
    closed,
    send: (data: string) => sent.push(JSON.parse(data) as SessionListFrame),
    close: (code?: number) => closed.push(code ?? 1000),
  };
}

/** A hub the test notifies by hand; `subscribe` resolves when `answer` is called, or at once. */
function hub({ held = false, fails = false } = {}) {
  const listeners = new Map<string, Set<() => void>>();
  let answer: () => void = () => {};
  let hearing = true;
  const released: string[] = [];
  const value: SessionListHub = {
    hearing: () => hearing,
    subscribe: async (userId, onChange) => {
      if (held) await new Promise<void>((resolve) => (answer = resolve));
      if (fails) throw new Error("listener down");
      const own = listeners.get(userId) ?? new Set();
      own.add(onChange);
      listeners.set(userId, own);
      return () => {
        own.delete(onChange);
        released.push(userId);
      };
    },
  };
  return {
    value,
    released,
    deafen: () => {
      hearing = false;
    },
    answer: () => answer(),
    notice: (userId: string) => {
      for (const onChange of listeners.get(userId) ?? []) onChange();
    },
  };
}

describe("openSessionListStream", () => {
  it("says ready once it is hearing, then passes on each change to this user's list", async () => {
    const source = hub();
    const ws = socket();
    const stream = openSessionListStream({ hub: source.value, userId: ALICE, socket: ws });
    await stream.ready;

    source.notice(ALICE);
    source.notice("someone-else");
    source.notice(ALICE);

    expect(ws.sent).toEqual([
      { type: "ready" },
      { type: "sessions.changed" },
      { type: "sessions.changed" },
    ]);
    stream.onClose();
  });

  it("says nothing, and holds nothing, once the socket has closed", async () => {
    // Fake timers so the heartbeat is countable: a closed flag would hide a timer left running.
    vi.useFakeTimers();
    const source = hub();
    const ws = socket();
    const stream = openSessionListStream({ hub: source.value, userId: ALICE, socket: ws });
    await stream.ready;

    expect(vi.getTimerCount()).toBe(1);
    stream.onClose();
    stream.onClose();
    source.notice(ALICE);

    expect(ws.sent).toEqual([{ type: "ready" }]);
    expect(source.released).toEqual([ALICE]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives back a subscription that arrives after the socket has gone", async () => {
    const source = hub({ held: true });
    const ws = socket();
    const stream = openSessionListStream({ hub: source.value, userId: ALICE, socket: ws });

    stream.onClose();
    source.answer();
    await stream.ready;

    expect(ws.sent).toEqual([]);
    expect(source.released).toEqual([ALICE]);
  });

  it("closes when notices cannot be heard, so the tab polls and tries again later", async () => {
    const ws = socket();
    const stream = openSessionListStream({
      hub: hub({ fails: true }).value,
      userId: ALICE,
      socket: ws,
    });
    await stream.ready;

    expect(ws.sent).toEqual([]);
    expect(ws.closed).toEqual([SESSION_LIST_UNAVAILABLE]);
  });

  it("pings, and closes a client that answers nothing", async () => {
    vi.useFakeTimers();
    const ws = socket();
    const stream = openSessionListStream({
      hub: hub().value,
      userId: ALICE,
      socket: ws,
      heartbeat: { intervalMs: 1000, timeoutMs: 3000 },
    });
    await stream.ready;

    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.sent.at(-1)).toEqual({ type: "ping" });
    stream.onMessage(JSON.stringify({ type: "pong" }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(ws.closed).toEqual([]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.closed).toEqual([WS_CLOSE.heartbeatTimeout]);
  });

  it("answers a frame it cannot read with an error, and stays open", async () => {
    const ws = socket();
    const stream = openSessionListStream({ hub: hub().value, userId: ALICE, socket: ws });
    await stream.ready;

    stream.onMessage("not json");

    expect(ws.sent.at(-1)).toMatchObject({ type: "error" });
    expect(ws.closed).toEqual([]);
    stream.onClose();
  });

  it("closes at its next heartbeat once the pod has stopped hearing, so the tab polls", async () => {
    vi.useFakeTimers();
    const source = hub();
    const ws = socket();
    const stream = openSessionListStream({
      hub: source.value,
      userId: ALICE,
      socket: ws,
      heartbeat: { intervalMs: 1000, timeoutMs: 30_000 },
    });
    await stream.ready;

    source.deafen();
    await vi.advanceTimersByTimeAsync(1000);

    expect(ws.closed).toEqual([SESSION_LIST_UNAVAILABLE]);
    expect(source.released).toEqual([ALICE]);
  });
});
