/**
 * The limiter takes `now` as an argument, so time here is arithmetic rather than fake timers.
 * That matters for the sliding-window assertions: proving the window *slides* means asking what
 * happens 59 and 61 minutes later, which is a thing to compute, not a thing to wait for.
 */

import { describe, expect, it } from "vitest";
import { TurnRateLimiter } from "./rate-limiter.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const ADA = "user-ada";
const BOB = "user-bob";

/** Records `count` turns for `userId`, all at `now`, and returns the last decision. */
function spend(limiter: TurnRateLimiter, userId: string, count: number, now: number) {
  let last = limiter.check(userId, now);
  for (let i = 1; i < count; i++) last = limiter.check(userId, now);
  return last;
}

describe("within the allowance", () => {
  it("allows exactly the configured number of turns", () => {
    const limiter = new TurnRateLimiter({ limit: 3, windowMs: HOUR });

    for (let i = 0; i < 3; i++) {
      expect(limiter.check(ADA, 0)).toEqual({ allowed: true });
    }
  });

  it("refuses the one after that", () => {
    const limiter = new TurnRateLimiter({ limit: 3, windowMs: HOUR });
    spend(limiter, ADA, 3, 0);

    expect(limiter.check(ADA, 0)).toMatchObject({ allowed: false });
  });

  it("does not consume the allowance on a refused attempt", () => {
    // Otherwise a client retrying in a loop pushes its own recovery further away every time,
    // and `retryAfterSeconds` becomes a number that never arrives.
    const limiter = new TurnRateLimiter({ limit: 1, windowMs: HOUR });
    limiter.check(ADA, 0);

    for (let i = 0; i < 5; i++) limiter.check(ADA, MINUTE);

    // The one allowed call was at 0, so the window clears an hour later regardless of the
    // refusals in between.
    expect(limiter.check(ADA, HOUR + 1)).toEqual({ allowed: true });
  });
});

describe("retryAfterSeconds", () => {
  it("says when the oldest call leaves the window", () => {
    const limiter = new TurnRateLimiter({ limit: 2, windowMs: HOUR });
    limiter.check(ADA, 0);
    limiter.check(ADA, 10 * MINUTE);

    // Asked 20 minutes in: the oldest call ages out at 60, so 40 minutes to wait.
    const refused = limiter.check(ADA, 20 * MINUTE);

    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 40 * 60 });
  });

  it("is never zero, so a client told to wait actually waits", () => {
    // Rounding down a sub-second remainder would produce `Retry-After: 0`, which is an
    // invitation to retry immediately and be refused again.
    const limiter = new TurnRateLimiter({ limit: 1, windowMs: 1_000 });
    limiter.check(ADA, 0);

    const refused = limiter.check(ADA, 999);

    expect(refused).toMatchObject({ allowed: false });
    if (refused.allowed) throw new Error("expected a refusal");
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("the window slides", () => {
  it("lets a turn through once the oldest one has aged out", () => {
    // The point of a sliding window. A fixed window would refuse until the boundary and then
    // hand back the whole allowance at once, which is both harsher and more abusable.
    const limiter = new TurnRateLimiter({ limit: 2, windowMs: HOUR });
    limiter.check(ADA, 0);
    limiter.check(ADA, 30 * MINUTE);

    expect(limiter.check(ADA, 45 * MINUTE)).toMatchObject({ allowed: false });
    // Just past the hour, the call at 0 has left the window and one slot is free again.
    expect(limiter.check(ADA, HOUR + 1)).toEqual({ allowed: true });
    // But only one: the call at 30 minutes is still inside it.
    expect(limiter.check(ADA, HOUR + 2)).toMatchObject({ allowed: false });
  });

  it("forgets a user who stops asking, rather than growing forever", () => {
    // The map is the only thing here that could leak. A user's entry has to disappear once
    // every timestamp in it has aged out, or a public deployment accumulates one per visitor.
    const limiter = new TurnRateLimiter({ limit: 1, windowMs: HOUR });
    limiter.check(ADA, 0);
    expect(limiter.size).toBe(1);

    limiter.check(BOB, HOUR * 2);

    // Ada's only timestamp is long gone; pruning happens as a side effect of Bob's check.
    expect(limiter.size).toBe(1);
  });
});

describe("limits are per user, not global", () => {
  it("does not spend one user's allowance on another's turns", () => {
    // The task's own "Done when". A limiter keyed on nothing would pass every other test here
    // and refuse the second person to arrive.
    const limiter = new TurnRateLimiter({ limit: 2, windowMs: HOUR });

    spend(limiter, ADA, 2, 0);
    expect(limiter.check(ADA, 0)).toMatchObject({ allowed: false });

    expect(limiter.check(BOB, 0)).toEqual({ allowed: true });
    expect(limiter.check(BOB, 0)).toEqual({ allowed: true });
    expect(limiter.check(BOB, 0)).toMatchObject({ allowed: false });
  });
});
