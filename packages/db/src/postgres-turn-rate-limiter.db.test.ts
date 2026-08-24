import { randomUUID } from "node:crypto";
import { and, eq, sql as sqlOf } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { PostgresTurnRateLimiter } from "./postgres-turn-rate-limiter.ts";
import { turnRateEvents, users } from "./schema.ts";

/**
 * The turn allowance against a real Postgres, because two of the things being tested cannot be
 * observed anywhere else: that two processes sharing one database enforce *one* allowance, and
 * that a burst of simultaneous admissions cannot overshoot it.
 *
 * Time is real here rather than arithmetic — the point of the move is that the database's clock is
 * the one every replica agrees on, so a limiter taking `now` from a caller would be the bug.
 * Ageing is therefore done by *backdating rows*, which is the same thing from the window's point
 * of view and takes no waiting. `in-memory-turn-rate-limiter.test.ts` covers the same properties
 * by arithmetic.
 *
 * **This file owns `turn_rate_events`**, like the capacity suite owns its table: `sweep` deletes
 * across every user, so a test of it cannot be scoped to its own rows.
 */

const HOUR_MS = 60 * 60 * 1000;

let sql: postgres.Sql;
let db: PostgresJsDatabase;

beforeAll(() => {
  // More than one connection, or a burst of concurrent transactions would be serialized by the
  // pool before the advisory lock ever saw them — and the test would pass without testing.
  sql = postgres(inject("postgresUrl"), { max: 16 });
  db = drizzle(sql);
});

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  await db.delete(turnRateEvents);
});

function limiter(limit: number, options?: { windowMs?: number; tier?: "free" | "paid" }) {
  return new PostgresTurnRateLimiter(db, {
    limit,
    windowMs: options?.windowMs ?? HOUR_MS,
    tier: options?.tier ?? "free",
  });
}

async function seedUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Ada" })
    .returning();
  return user?.id ?? "";
}

/** Moves a user's recorded turns back in time, which is how the window is aged without waiting. */
async function backdate(userId: string, minutes: number): Promise<void> {
  await db
    .update(turnRateEvents)
    .set({ at: sqlOf`${turnRateEvents.at} - ${`${minutes} minutes`}::interval` })
    .where(eq(turnRateEvents.userId, userId));
}

async function rowsFor(userId: string, tier: "free" | "paid" = "free"): Promise<number> {
  const rows = await db
    .select()
    .from(turnRateEvents)
    .where(and(eq(turnRateEvents.userId, userId), eq(turnRateEvents.tier, tier)));
  return rows.length;
}

describe("the allowance", () => {
  it("allows exactly the configured number of turns and refuses the next", async () => {
    const rate = limiter(3);
    const ada = await seedUser();

    for (let i = 0; i < 3; i += 1) expect(await rate.check(ada)).toEqual({ allowed: true });

    expect(await rate.check(ada)).toMatchObject({ allowed: false });
  });

  it("records one row per accepted turn and nothing for a refusal", async () => {
    // The property the whole design turns on: a client retrying in a loop must not push its own
    // recovery further away with every attempt, or the wait it was told never arrives.
    const rate = limiter(2);
    const ada = await seedUser();

    await rate.check(ada);
    await rate.check(ada);
    for (let i = 0; i < 5; i += 1) await rate.check(ada);

    expect(await rowsFor(ada)).toBe(2);
  });

  it("does not spend one user's allowance on another's turns", async () => {
    const rate = limiter(1);
    const [ada, bob] = [await seedUser(), await seedUser()];

    expect(await rate.check(ada)).toEqual({ allowed: true });
    expect(await rate.check(ada)).toMatchObject({ allowed: false });
    expect(await rate.check(bob)).toEqual({ allowed: true });
  });

  it("keeps the free and paid allowances separate", async () => {
    // Two limiters rather than two numbers on one: sharing a window would let somebody's paid
    // turns eat their free allowance.
    const free = limiter(1, { tier: "free" });
    const paid = limiter(1, { tier: "paid" });
    const ada = await seedUser();

    expect(await free.check(ada)).toEqual({ allowed: true });
    expect(await free.check(ada)).toMatchObject({ allowed: false });

    expect(await paid.check(ada)).toEqual({ allowed: true });
    expect(await rowsFor(ada, "paid")).toBe(1);
  });
});

describe("retryAfterSeconds", () => {
  it("says when the oldest turn leaves the window", async () => {
    const rate = limiter(2);
    const ada = await seedUser();

    await rate.check(ada);
    await backdate(ada, 20);
    await rate.check(ada);
    await backdate(ada, 10);

    // The two turns now sit 30 and 10 minutes back, so the oldest ages out in 30 minutes.
    const refused = await rate.check(ada);

    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("expected a refusal");
    // A window either side of exact, since the clock really is running between the statements.
    expect(refused.retryAfterSeconds).toBeGreaterThan(30 * 60 - 5);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(30 * 60);
  });

  it("is never zero, so a client told to wait actually waits", async () => {
    // Rounding a sub-second remainder down would produce `Retry-After: 0`, which is an
    // invitation to retry immediately and be refused again.
    const rate = limiter(1, { windowMs: 1_000 });
    const ada = await seedUser();

    await rate.check(ada);
    const refused = await rate.check(ada);

    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("expected a refusal");
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("the window slides", () => {
  it("lets a turn through once the oldest one has aged out, and only one", async () => {
    // A fixed window would refuse until the boundary and then hand back the whole allowance at
    // once, which is both harsher and more abusable.
    const rate = limiter(2);
    const ada = await seedUser();

    await rate.check(ada);
    await backdate(ada, 30);
    await rate.check(ada);
    expect(await rate.check(ada)).toMatchObject({ allowed: false });

    // Now the first turn is 61 minutes back and the second is 31.
    await backdate(ada, 31);

    expect(await rate.check(ada)).toEqual({ allowed: true });
    expect(await rate.check(ada)).toMatchObject({ allowed: false });
  });
});

describe("two processes, one allowance", () => {
  it("enforces one window across separate limiter instances", async () => {
    // The reason any of this moved out of a `Map`. Two instances stand in for two replicas.
    const replicaA = limiter(3);
    const replicaB = limiter(3);
    const ada = await seedUser();

    expect(await replicaA.check(ada)).toEqual({ allowed: true });
    expect(await replicaB.check(ada)).toEqual({ allowed: true });
    expect(await replicaA.check(ada)).toEqual({ allowed: true });

    expect(await replicaB.check(ada)).toMatchObject({ allowed: false });
  });

  it("admits exactly the allowance under a simultaneous burst", async () => {
    // Counting and then inserting are not one operation: without the advisory lock every caller
    // in this burst reads the same count, decides there is room, and inserts.
    const limit = 5;
    const replicas = [limiter(limit), limiter(limit), limiter(limit)];
    const ada = await seedUser();

    const decisions = await Promise.all(
      Array.from({ length: 30 }, (_, i) => {
        const replica = replicas[i % replicas.length];
        if (replica === undefined) throw new Error("no replica");
        return replica.check(ada);
      }),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(limit);
    expect(await rowsFor(ada)).toBe(limit);
  });
});

describe("sweeping", () => {
  it("deletes what has left the window and leaves what has not", async () => {
    // Otherwise the table grows one row per visitor forever, and a public deployment pays for
    // remembering people who sent one message and never came back.
    const rate = limiter(5);
    const [ada, bob] = [await seedUser(), await seedUser()];

    await rate.check(ada);
    await rate.check(ada);
    await backdate(ada, 61);
    await rate.check(bob);

    expect(await rate.sweep()).toBe(2);
    expect(await rowsFor(ada)).toBe(0);
    expect(await rowsFor(bob)).toBe(1);
  });

  it("leaves the other tier's rows alone", async () => {
    // The two limiters are two windows and may one day be two different lengths; sweeping the
    // whole table from either would make one limiter's configuration govern the other's rows.
    const free = limiter(5, { tier: "free" });
    const paid = limiter(5, { tier: "paid" });
    const ada = await seedUser();

    await free.check(ada);
    await paid.check(ada);
    await backdate(ada, 61);

    expect(await free.sweep()).toBe(1);
    expect(await rowsFor(ada, "paid")).toBe(1);
  });

  it("does not change what anybody may spend", async () => {
    const rate = limiter(2);
    const ada = await seedUser();

    await rate.check(ada);
    expect(await rate.sweep()).toBe(0);

    expect(await rate.check(ada)).toEqual({ allowed: true });
    expect(await rate.check(ada)).toMatchObject({ allowed: false });
  });
});
