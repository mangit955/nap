import { type Logger, setRootLogger } from "@nap/shared/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAIM_CHANNEL, PostgresClaimChannel } from "./postgres-claim-channel.ts";
import { NotifyHub } from "./testing/in-memory-notify-transport.ts";

/**
 * What goes down the channel and what comes back out of it.
 *
 * Whether a real `LISTEN` hears a real `NOTIFY` is `postgres-claim-channel.db.test.ts`, and what a
 * worker does about a wake-up is `turn-worker-wakeups.test.ts`.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PostgresClaimChannel", () => {
  it("wakes every listener on the channel, in every process", async () => {
    const hub = new NotifyHub();
    let first = 0;
    let second = 0;
    await new PostgresClaimChannel(hub.connect()).listen(() => first++);
    await new PostgresClaimChannel(hub.connect()).listen(() => second++);

    new PostgresClaimChannel(hub.connect()).announce();

    expect([first, second]).toEqual([1, 1]);
  });

  it("hears a wake-up whatever its payload, because there is nothing in one to trust", async () => {
    // An older or newer replica mid-rollout may send something here. Whatever it sent, the only
    // thing a worker does about it is ask the queue, which is safe to do for no reason at all.
    const hub = new NotifyHub();
    let heard = 0;
    await new PostgresClaimChannel(hub.connect()).listen(() => heard++);

    await hub.connect().notify(CLAIM_CHANNEL, "something from another version");

    expect(heard).toBe(1);
  });

  it("is a channel of its own, so a cancel or an event wakes no claim", async () => {
    const hub = new NotifyHub();
    let heard = 0;
    await new PostgresClaimChannel(hub.connect()).listen(() => heard++);

    await hub.connect().notify("nap_cancel", "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f");
    await hub.connect().notify("nap_events", "{}");

    expect(heard).toBe(0);
  });

  it("treats a failed send as a missed wake-up, which it reports and does not throw", async () => {
    // The row was committed before this was called, so nothing here may cost the caller its 202.
    const warn = vi.fn();
    const quiet = () => {};
    const logger: Logger = { debug: quiet, info: quiet, warn, error: quiet, child: () => logger };
    setRootLogger(logger);
    const channel = new PostgresClaimChannel({
      notify: () => Promise.reject(new Error("the pool is exhausted")),
      listen: async () => async () => {},
    });

    expect(() => channel.announce()).not.toThrow();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
  });

  it("says it is hearing when nothing was given to ask", () => {
    expect(new PostgresClaimChannel(new NotifyHub().connect()).hearing()).toBe(true);
  });

  it("says whatever the listener's own health check says", () => {
    // The event bus's echo heartbeat runs over the same socket, so it is this channel's health too.
    let alive = true;
    const channel = new PostgresClaimChannel(new NotifyHub().connect(), { hearing: () => alive });

    expect(channel.hearing()).toBe(true);
    alive = false;
    expect(channel.hearing()).toBe(false);
  });
});
