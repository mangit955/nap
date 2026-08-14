/**
 * That a workspace has one subscription, and that every question is answered from it.
 *
 * The bug this file exists to prevent is not a crash: it is three panes each opening a socket for
 * the same session, which shows up as two halves of the screen disagreeing about what the newest
 * event was — and nothing in a green render test can see it. So the assertion is about how many
 * sockets were opened, which is only countable because the factory is an argument.
 *
 * A `.tsx` file with no JSX in it, deliberately: the `web` vitest project globs `*.test.tsx`, and
 * the same file named `.test.ts` would be collected by `unit`, which has no DOM.
 */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ev, OTHER_SESSION_ID, SESSION_ID } from "../testing/events.ts";
import { sockets } from "../testing/fake-socket.ts";
import { useSessionLog } from "./use-session-log.ts";

const URL_BASE = "ws://api.test";

function open(
  net: ReturnType<typeof sockets>,
  props: { sessionId?: string | undefined; putAwayAt?: string; resuming?: boolean } = {},
) {
  net.countGlobalToo(vi.stubGlobal);

  return renderHook(
    (current: { sessionId?: string | undefined; putAwayAt?: string; resuming?: boolean }) =>
      useSessionLog({
        sessionId: "sessionId" in current ? current.sessionId : SESSION_ID,
        baseUrl: URL_BASE,
        createSocket: net.createSocket,
        ...(current.putAwayAt === undefined ? {} : { putAwayAt: current.putAwayAt }),
        ...(current.resuming === undefined ? {} : { resuming: current.resuming }),
      }),
    { initialProps: props },
  );
}

/** Frames arriving from the server, flushed the way React flushes a real message. */
function deliver(net: ReturnType<typeof sockets>, ...events: ReturnType<typeof ev>[]) {
  act(() => {
    for (const event of events) net.latest.deliver({ type: "event", event });
  });
}

describe("the subscription", () => {
  it("opens one socket for the session", () => {
    const net = sockets();
    open(net);

    expect(net.opened).toHaveLength(1);
    expect(new URL(net.latest.url).searchParams.get("sessionId")).toBe(SESSION_ID);
  });

  it("opens none until there is a session", () => {
    // The shell renders before the project record has arrived, and the session id comes from the
    // record. A connection to `undefined` is a connection to nothing.
    const net = sockets();
    const { result } = open(net, { sessionId: undefined });

    expect(net.opened).toHaveLength(0);
    expect(result.current.events).toEqual([]);
  });

  it("starts again from nothing when the session changes", () => {
    const net = sockets();
    const { result, rerender } = open(net);
    deliver(net, ev("agent.message", { text: "hello" }, 1));
    expect(result.current.events).toHaveLength(1);

    rerender({ sessionId: OTHER_SESSION_ID });

    // A different session is a different conversation, not a continuation of this one.
    expect(result.current.events).toEqual([]);
    expect(result.current.lastSeq).toBe(0);
  });
});

describe("what the log is asked", () => {
  it("names the newest announcement, with the sequence number that carried it", () => {
    // Both are in the log: the sandbox that was closed, and the one that replaced it. The `seq`
    // is the load-bearing half — an address alone cannot say which one is live, and taking the
    // older one points the frame at a sandbox that no longer exists.
    const net = sockets();
    const { result } = open(net);

    deliver(
      net,
      ev("preview.ready", { url: "https://5173-old.e2b.app", port: 5173 }, 7),
      ev("preview.stopped", {}, 8),
      ev("preview.ready", { url: "https://5173-new.e2b.app", port: 5173 }, 9),
    );

    expect(result.current.preview).toMatchObject({
      status: "ready",
      url: "https://5173-new.e2b.app",
      seq: 9,
    });
  });

  it("stops naming a preview once it has been stopped", () => {
    const net = sockets();
    const { result } = open(net);

    deliver(
      net,
      ev("preview.ready", { url: "https://5173-sbx.e2b.app", port: 5173 }, 7),
      ev("preview.stopped", {}, 8),
    );

    expect(result.current.preview.status).not.toBe("ready");
  });

  it("collects the paths this session has written, in the shape the listing uses", () => {
    const net = sockets();
    const { result } = open(net);

    deliver(
      net,
      ev(
        "file.changed",
        { path: "/home/user/app/src/App.tsx", changeType: "modified", diff: "" },
        3,
      ),
      ev(
        "file.changed",
        { path: "/home/user/app/src/gone.ts", changeType: "deleted", diff: "" },
        4,
      ),
    );

    // The deleted one is absent: there is no node left in the tree to mark.
    expect([...result.current.changed]).toEqual(["src/App.tsx"]);
  });

  it("calls a project put away when the record says so and nothing is coming up", () => {
    const net = sockets();
    const { result } = open(net, { putAwayAt: "2026-08-09T13:00:00.000Z" });

    deliver(net, ev("preview.ready", { url: "https://5173-sbx.e2b.app", port: 5173 }, 7));

    expect(result.current.putAway).toBe(true);
  });

  it("does not call it put away while a restore is under way", () => {
    // A restore is under way from the moment it is asked for, which is minutes before the event
    // saying so arrives. Both panes read this one answer, so they cannot disagree about it.
    const net = sockets();
    const { result } = open(net, { putAwayAt: "2026-08-09T13:00:00.000Z", resuming: true });

    deliver(net, ev("preview.ready", { url: "https://5173-sbx.e2b.app", port: 5173 }, 7));

    expect(result.current.putAway).toBe(false);
  });
});
