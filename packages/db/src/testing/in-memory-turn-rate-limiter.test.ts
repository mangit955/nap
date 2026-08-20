/**
 * The fake's clock is a constructor argument, so time here is arithmetic rather than fake timers.
 * That matters for the sliding-window assertions: proving the window *slides* means asking what
 * happens 59 and 61 minutes later, which is a thing to compute, not a thing to wait for.
 *
 * `postgres-turn-rate-limiter.db.test.ts` asserts the same properties against the real one.
 */

import { describe, expect, it } from "vitest";
import { InMemoryTurnRateLimiter } from "./in-memory-turn-rate-limiter.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const ADA = "user-ada";
const BOB = "user-bob";

/** A limiter whose clock this test moves by assignment. */
function atClock(limit: number, windowMs: number) {
  const clock = { now: 0 };
  const limiter = new InMemoryTurnRateLimiter({ limit, windowMs, now: () => clock.now });
  return { limiter, clock };
}

/** Records `count` turns for `userId` at the clock's current time, returning the last decision. */
async function spend(limiter: InMemoryTurnRateLimiter, userId: string, count: number) {
  let last = await limiter.check(userId);
  for (let i = 1; i < count; i++) last = await limiter.check(userId);
  return last;
}

describe("within the allowance", () => {
  it("allows exactly the configured number of turns", async () => {
    const { limiter } = atClock(3, HOUR);

    for (let i = 0; i < 3; i++) {
      expect(await limiter.check(ADA)).toEqual({ allowed: true });
    }
  });

  it("refuses the one after that", async () => {
    const { limiter } = atClock(3, HOUR);
    await spend(limiter, ADA, 3);

    expect(await limiter.check(ADA)).toMatchObject({ allowed: false });
  });

  it("does not consume the allowance on a refused attempt", async () => {
    // Otherwise a client retrying in a loop pushes its own recovery further away every time,
    // and `retryAfterSeconds` becomes a number that never arrives.
    const { limiter, clock } = atClock(1, HOUR);
    await limiter.check(ADA);

    clock.now = MINUTE;
    for (let i = 0; i < 5; i++) await limiter.check(ADA);

    // The one allowed call was at 0, so the window clears an hour later regardless of the
    // refusals in between.
    clock.now = HOUR + 1;
    expect(await limiter.check(ADA)).toEqual({ allowed: true });
  });
});

describe("retryAfterSeconds", () => {
  it("says when the oldest call leaves the window", async () => {
    const { limiter, clock } = atClock(2, HOUR);
    await limiter.check(ADA);
    clock.now = 10 * MINUTE;
    await limiter.check(ADA);

    // Asked 20 minutes in: the oldest call ages out at 60, so 40 minutes to wait.
    clock.now = 20 * MINUTE;
    expect(await limiter.check(ADA)).toEqual({ allowed: false, retryAfterSeconds: 40 * 60 });
  });

  it("is never zero, so a client told to wait actually waits", async () => {
    // Rounding down a sub-second remainder would produce `Retry-After: 0`, which is an
    // invitation to retry immediately and be refused again.
    const { limiter, clock } = atClock(1, 1_000);
    await limiter.check(ADA);

    clock.now = 999;
    const refused = await limiter.check(ADA);

    expect(refused).toMatchObject({ allowed: false });
    if (refused.allowed) throw new Error("expected a refusal");
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("the window slides", () => {
  it("lets a turn through once the oldest one has aged out", async () => {
    // The point of a sliding window. A fixed window would refuse until the boundary and then
    // hand back the whole allowance at once, which is both harsher and more abusable.
    const { limiter, clock } = atClock(2, HOUR);
    await limiter.check(ADA);
    clock.now = 30 * MINUTE;
    await limiter.check(ADA);

    clock.now = 45 * MINUTE;
    expect(await limiter.check(ADA)).toMatchObject({ allowed: false });
    // Just past the hour, the call at 0 has left the window and one slot is free again.
    clock.now = HOUR + 1;
    expect(await limiter.check(ADA)).toEqual({ allowed: true });
    // But only one: the call at 30 minutes is still inside it.
    clock.now = HOUR + 2;
    expect(await limiter.check(ADA)).toMatchObject({ allowed: false });
  });

  it("forgets a user who stops asking, rather than growing forever", async () => {
    // A user's record has to disappear once every time in it has aged out, or a public
    // deployment accumulates one per visitor and never sheds it.
    const { limiter, clock } = atClock(1, HOUR);
    await limiter.check(ADA);
    expect(limiter.size).toBe(1);

    clock.now = HOUR * 2;
    expect(await limiter.sweep()).toBe(1);
    expect(limiter.size).toBe(0);
  });

  it("leaves a sweep nothing to do when everything is still inside the window", async () => {
    const { limiter, clock } = atClock(2, HOUR);
    await limiter.check(ADA);

    clock.now = 30 * MINUTE;
    expect(await limiter.sweep()).toBe(0);
    // And the allowance is unchanged by having been swept.
    expect(await limiter.check(ADA)).toEqual({ allowed: true });
    expect(await limiter.check(ADA)).toMatchObject({ allowed: false });
  });
});

describe("limits are per user, not global", () => {
  it("does not spend one user's allowance on another's turns", async () => {
    const { limiter } = atClock(2, HOUR);

    await spend(limiter, ADA, 2);
    expect(await limiter.check(ADA)).toMatchObject({ allowed: false });

    expect(await limiter.check(BOB)).toEqual({ allowed: true });
    expect(await limiter.check(BOB)).toEqual({ allowed: true });
    expect(await limiter.check(BOB)).toMatchObject({ allowed: false });
  });
});
