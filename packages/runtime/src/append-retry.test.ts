import { describe, expect, it } from "vitest";
import { APPEND_ATTEMPTS, appendBackoffMs, isTransientAppendFailure } from "./append-retry.ts";

/**
 * Which append failures are worth a second try, and how long to wait between them.
 *
 * The classification is a whitelist, so the tests that matter most are the negative ones: a
 * unique violation retried is a duplicated message in somebody's chat, and a parse failure
 * retried is corruption reported four times instead of once.
 */

/** What drizzle hands back: its own error, with the driver's underneath. */
function wrapped(cause: unknown): Error {
  return Object.assign(new Error("Failed query: insert into events ..."), { cause });
}

function sqlstate(code: string): Error {
  return Object.assign(new Error("something the server said"), { code, name: "PostgresError" });
}

function driverCode(code: string): Error {
  return Object.assign(new Error(`write ${code} db.example:5432`), { code, errno: code });
}

describe("which failures are worth retrying", () => {
  it.each(["40001", "40P01", "57P01"])("retries the transient sqlstate %s", (code) => {
    expect(isTransientAppendFailure(sqlstate(code))).toBe(true);
  });

  it.each(["CONNECTION_CLOSED", "CONNECTION_DESTROYED", "CONNECTION_ENDED", "CONNECT_TIMEOUT"])(
    "retries the driver's %s",
    (code) => {
      expect(isTransientAppendFailure(driverCode(code))).toBe(true);
    },
  );

  it.each(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT"])(
    "retries the socket error %s",
    (code) => {
      expect(isTransientAppendFailure(driverCode(code))).toBe(true);
    },
  );

  it("looks through drizzle's wrapper for the driver's code", () => {
    // Drizzle reports `Failed query: …` and puts the real reason on `.cause`, so a classifier
    // reading only the top-level error sees nothing it recognises and never retries anything.
    expect(isTransientAppendFailure(wrapped(sqlstate("40001")))).toBe(true);
  });
});

describe("which failures must stay fatal", () => {
  it("never retries a unique violation", () => {
    // `unique(session_id, seq)` firing means two writers assigned the same seq. Retrying would
    // either duplicate the event or bury the fact that the ordering guarantee broke.
    expect(isTransientAppendFailure(sqlstate("23505"))).toBe(false);
    expect(isTransientAppendFailure(wrapped(sqlstate("23505")))).toBe(false);
  });

  it("never retries a foreign key violation", () => {
    expect(isTransientAppendFailure(sqlstate("23503"))).toBe(false);
  });

  it("never retries a parse failure", () => {
    // A row that does not match the event union is corruption. It will not parse on the second
    // attempt either, and the retry only delays the report.
    expect(
      isTransientAppendFailure(Object.assign(new Error("invalid"), { name: "ZodError" })),
    ).toBe(false);
  });

  it("treats anything it does not recognise as fatal", () => {
    expect(isTransientAppendFailure(new Error("the store is down"))).toBe(false);
    expect(isTransientAppendFailure("a string nobody threw on purpose")).toBe(false);
    expect(isTransientAppendFailure(null)).toBe(false);
  });
});

describe("how long the sink waits", () => {
  it("makes three attempts", () => {
    expect(APPEND_ATTEMPTS).toBe(3);
  });

  it("quadruples the wait each time", () => {
    // The schedule is 100 / 400 / 1600; three attempts reach the first two of it.
    expect(appendBackoffMs(1, () => 0.5)).toBe(100);
    expect(appendBackoffMs(2, () => 0.5)).toBe(400);
    expect(appendBackoffMs(3, () => 0.5)).toBe(1600);
  });

  it("spreads each wait by a quarter either way", () => {
    // Without jitter every turn that lost the same connection comes back at the same moment,
    // which is how a transient blip becomes a sustained one.
    expect(appendBackoffMs(1, () => 0)).toBe(75);
    expect(appendBackoffMs(1, () => 1)).toBe(125);
    expect(appendBackoffMs(2, () => 0)).toBe(300);
    expect(appendBackoffMs(2, () => 1)).toBe(500);
  });
});
