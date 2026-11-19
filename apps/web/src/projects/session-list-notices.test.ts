import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeSocket, sockets } from "../testing/fake-socket.ts";
import {
  createSessionListNotices,
  NOTICE_BACKOFF,
  NOTICE_COALESCE_MS,
  NOTICE_LINGER_MS,
  NOTICE_SILENCE_MS,
  type SessionListNotice,
} from "./session-list-notices.ts";

afterEach(() => {
  vi.useRealTimers();
});

function deliver(socket: FakeSocket, frame: object) {
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
}

function setup(fetchTicket?: () => Promise<string | undefined>, random = () => 1) {
  vi.useFakeTimers();
  const net = sockets();
  const notices = createSessionListNotices({
    createSocket: net.createSocket,
    fetchTicket,
    baseUrl: "wss://api.example.com",
    // The top of the jitter's range, so a reconnect waits exactly the backoff.
    random,
  });
  const heard: SessionListNotice[] = [];
  return { net, notices, heard, listener: (notice: SessionListNotice) => heard.push(notice) };
}

describe("createSessionListNotices", () => {
  it("opens one socket for every list in the tab, and closes it a little after the last", async () => {
    const { net, notices } = setup();

    const first = notices.subscribe(() => {});
    const second = notices.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(net.opened).toHaveLength(1);
    expect(net.latest.url).toBe("wss://api.example.com/ws/account");

    first();
    second();
    expect(net.latest.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(NOTICE_LINGER_MS);
    expect(net.latest.closed).toBe(true);
  });

  it("keeps the socket across a move from one list to the next", async () => {
    // The dashboard's list and a project's sidebar are never mounted at once.
    const { net, notices } = setup();
    const dashboard = notices.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    deliver(net.latest, { type: "ready" });

    dashboard();
    await vi.advanceTimersByTimeAsync(NOTICE_LINGER_MS / 2);
    const sidebar = notices.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(NOTICE_LINGER_MS);

    expect(net.opened).toHaveLength(1);
    expect(net.latest.closed).toBe(false);
    expect(notices.live()).toBe(true);
    sidebar();
  });

  it("takes a socket that has said nothing for too long for dead, and reconnects", async () => {
    // A laptop that slept leaves a socket that never closes and never delivers.
    const { net, notices, heard, listener } = setup();
    const stop = notices.subscribe(listener);
    await vi.advanceTimersByTimeAsync(0);
    deliver(net.latest, { type: "ready" });

    await vi.advanceTimersByTimeAsync(NOTICE_SILENCE_MS / 2);
    deliver(net.latest, { type: "ping" });
    await vi.advanceTimersByTimeAsync(NOTICE_SILENCE_MS / 2);
    expect(notices.live()).toBe(true);

    // Checked every fifth of the limit, so it is noticed within that much after the limit.
    await vi.advanceTimersByTimeAsync(NOTICE_SILENCE_MS / 2 + NOTICE_SILENCE_MS / 5);
    expect(notices.live()).toBe(false);
    expect(heard).toEqual(["live", "down"]);
    expect(net.opened[0]?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(NOTICE_BACKOFF.initialMs);
    expect(net.opened).toHaveLength(2);
    stop();
  });

  it("spreads reconnects over the second half of the backoff", async () => {
    const { net, notices } = setup(undefined, () => 0);
    const stop = notices.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);

    net.latest.drop();
    await vi.advanceTimersByTimeAsync(NOTICE_BACKOFF.initialMs / 2 - 1);
    expect(net.opened).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(net.opened).toHaveLength(2);
    stop();
  });

  it("carries a ticket, asked for before every connection, where one is needed", async () => {
    const fetchTicket = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    const { net, notices } = setup(fetchTicket);
    const stop = notices.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(net.latest.url).toBe("wss://api.example.com/ws/account?ticket=first");

    net.latest.drop();
    await vi.advanceTimersByTimeAsync(NOTICE_BACKOFF.initialMs);

    expect(net.opened).toHaveLength(2);
    expect(net.latest.url).toBe("wss://api.example.com/ws/account?ticket=second");
    stop();
  });

  it("is live once the server is hearing, and says so to every list", async () => {
    const { net, notices, heard, listener } = setup();
    const stop = notices.subscribe(listener);
    await vi.advanceTimersByTimeAsync(0);
    net.latest.open();
    expect(notices.live()).toBe(false);

    deliver(net.latest, { type: "ready" });

    expect(notices.live()).toBe(true);
    expect(heard).toEqual(["live"]);
    stop();
  });

  it("answers a burst of changes with one notice", async () => {
    const { net, notices, heard, listener } = setup();
    const stop = notices.subscribe(listener);
    await vi.advanceTimersByTimeAsync(0);
    deliver(net.latest, { type: "ready" });

    deliver(net.latest, { type: "sessions.changed" });
    deliver(net.latest, { type: "sessions.changed" });
    deliver(net.latest, { type: "sessions.changed" });
    expect(heard).toEqual(["live"]);
    await vi.advanceTimersByTimeAsync(NOTICE_COALESCE_MS);

    expect(heard).toEqual(["live", "changed"]);
    deliver(net.latest, { type: "sessions.changed" });
    await vi.advanceTimersByTimeAsync(NOTICE_COALESCE_MS);
    expect(heard).toEqual(["live", "changed", "changed"]);
    stop();
  });

  it("answers the heartbeat", async () => {
    const { net, notices } = setup();
    const stop = notices.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);

    deliver(net.latest, { type: "ping" });

    expect(net.latest.frames).toEqual([{ type: "pong" }]);
    stop();
  });

  it("says it is down when the socket drops, and reconnects on a lengthening curve", async () => {
    const { net, notices, heard, listener } = setup();
    const stop = notices.subscribe(listener);
    await vi.advanceTimersByTimeAsync(0);
    deliver(net.latest, { type: "ready" });

    net.latest.drop();
    expect(notices.live()).toBe(false);
    expect(heard).toEqual(["live", "down"]);

    await vi.advanceTimersByTimeAsync(NOTICE_BACKOFF.initialMs);
    expect(net.opened).toHaveLength(2);
    // Refused before it was ever live: no second "down", and the wait doubles.
    net.latest.drop();
    expect(heard).toEqual(["live", "down"]);
    await vi.advanceTimersByTimeAsync(NOTICE_BACKOFF.initialMs);
    expect(net.opened).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(NOTICE_BACKOFF.initialMs);
    expect(net.opened).toHaveLength(3);

    // Live again, and the curve starts over.
    deliver(net.latest, { type: "ready" });
    expect(heard).toEqual(["live", "down", "live"]);
    net.latest.drop();
    await vi.advanceTimersByTimeAsync(NOTICE_BACKOFF.initialMs);
    expect(net.opened).toHaveLength(4);
    stop();
  });

  it("leaves nothing behind once the last list has gone, a pending retry included", async () => {
    const { net, notices } = setup();
    const stop = notices.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    net.latest.drop();

    stop();
    await vi.advanceTimersByTimeAsync(NOTICE_LINGER_MS);
    const opened = net.opened.length;
    expect(net.latest.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(NOTICE_BACKOFF.maxMs);

    expect(net.opened).toHaveLength(opened);
  });
});
