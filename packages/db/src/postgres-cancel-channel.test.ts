import { type Logger, setRootLogger } from "@nap/shared/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANCEL_CHANNEL, PostgresCancelChannel } from "./postgres-cancel-channel.ts";
import { NotifyHub } from "./testing/in-memory-notify-transport.ts";

/**
 * What goes down the channel and what comes back out of it.
 *
 * Whether a real `LISTEN` hears a real `NOTIFY` is `postgres-cancel-channel.db.test.ts`, and what a
 * worker does about a wake-up is `turn-worker.test.ts`. What is left is the parsing, which is where
 * a mixed-version rollout lands, and that a failed send stays a missed wake-up.
 */

const REQUEST = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PostgresCancelChannel", () => {
  it("carries the request id across processes, and nothing else", async () => {
    const hub = new NotifyHub();
    const heard: string[] = [];
    await new PostgresCancelChannel(hub.connect()).listen((id) => heard.push(id));
    const raw: string[] = [];
    const elsewhere = hub.connect();
    await elsewhere.listen(CANCEL_CHANNEL, (payload) => raw.push(payload));

    new PostgresCancelChannel(elsewhere).announce(REQUEST);

    expect(heard).toEqual([REQUEST]);
    expect(raw).toEqual([REQUEST]);
  });

  it.each([
    ["a session-shaped payload from another version", JSON.stringify({ sessionId: REQUEST })],
    ["not an id at all", "cancel everything"],
    ["nothing", ""],
  ])("ignores %s rather than handing it to a worker", async (_name, payload) => {
    const hub = new NotifyHub();
    const heard: string[] = [];
    await new PostgresCancelChannel(hub.connect()).listen((id) => heard.push(id));

    await hub.connect().notify(CANCEL_CHANNEL, payload);

    expect(heard).toEqual([]);
  });

  it("treats a failed send as a missed wake-up, which it reports and does not throw", async () => {
    // The cancel was durable before this was called, so nothing here may cost the caller its 202 —
    // an unhandled rejection would cost the whole API process rather than one request.
    const warn = vi.fn();
    const quiet = () => {};
    const logger: Logger = {
      debug: quiet,
      info: quiet,
      warn,
      error: quiet,
      child: () => logger,
    };
    setRootLogger(logger);
    const channel = new PostgresCancelChannel({
      notify: () => Promise.reject(new Error("the pool is exhausted")),
      listen: async () => async () => {},
    });

    expect(() => channel.announce(REQUEST)).not.toThrow();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ requestId: REQUEST });
  });

  it("stops delivering when told to, on a connection that has not been lost", async () => {
    // Only that: after a reconnect the stop resolves and delivery goes on. See `listen`.
    const hub = new NotifyHub();
    const heard: string[] = [];
    const channel = new PostgresCancelChannel(hub.connect());
    const stop = await channel.listen((id) => heard.push(id));

    await stop();
    channel.announce(REQUEST);

    expect(heard).toEqual([]);
  });
});
