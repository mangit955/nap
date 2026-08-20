/**
 * The notification payload, parsed rather than trusted.
 *
 * The channel is shared by every process on the database, so a payload this version does not
 * understand is a thing that actually happens — an older or newer replica mid-rollout. What
 * matters is that it costs one ignored wake-up rather than the listener, which is why every
 * malformed shape below has to come back as `null` instead of throwing out of a handler that
 * nothing is waiting on.
 */

import { describe, expect, it } from "vitest";
import {
  decodeHeartbeat,
  decodeNotification,
  EVENT_CHANNEL,
  encodeNotification,
  HEARTBEAT_CHANNEL,
} from "./event-notification.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";

describe("the event notification", () => {
  it("round-trips a session and a seq", () => {
    expect(decodeNotification(encodeNotification({ sessionId: SESSION, seq: 7 }))).toEqual({
      sessionId: SESSION,
      seq: 7,
    });
  });

  it("carries the session and the seq and nothing else", () => {
    const encoded = encodeNotification({ sessionId: SESSION, seq: 7 });

    // The 8000-byte NOTIFY cap is why: an event's payload holds command output and file
    // contents, so a payload-carrying design fails on exactly the largest events. A test
    // rather than a comment, because the tempting change is one line in `publish`.
    expect(Object.keys(JSON.parse(encoded) as object).sort()).toEqual(["seq", "sessionId"]);
    expect(encoded.length).toBeLessThan(200);
  });

  it.each([
    ["not json at all", "}{"],
    ["an empty payload", ""],
    ["a json scalar", '"hello"'],
    ["a missing seq", `{"sessionId":"${SESSION}"}`],
    ["a seq of zero, which no event has", `{"sessionId":"${SESSION}","seq":0}`],
    ["a seq that is not a number", `{"sessionId":"${SESSION}","seq":"3"}`],
    ["a session id that is not a uuid", '{"sessionId":"nope","seq":3}'],
  ])("ignores %s", (_case, payload) => {
    expect(decodeNotification(payload)).toBeNull();
  });
});

describe("the heartbeat", () => {
  it("gives back the instance that sent it", () => {
    expect(decodeHeartbeat(JSON.stringify({ instanceId: "pod-a" }))).toBe("pod-a");
  });

  it.each([
    ["not json at all", "}{"],
    ["a missing instance", "{}"],
    ["an empty instance", '{"instanceId":""}'],
  ])("ignores %s", (_case, payload) => {
    expect(decodeHeartbeat(payload)).toBeNull();
  });

  it("is a different channel from the events one", () => {
    // Or the events channel would carry something other than `{sessionId, seq}`, which is the
    // one thing the design says it never does.
    expect(HEARTBEAT_CHANNEL).not.toBe(EVENT_CHANNEL);
  });
});
