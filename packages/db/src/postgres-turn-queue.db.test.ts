import { randomUUID } from "node:crypto";
import { eq, sql as sqlOf } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { PostgresTurnQueue } from "./postgres-turn-queue.ts";
import { projects, sessions, turnRequests, users } from "./schema.ts";

/**
 * The queue against a real Postgres, because the thing being tested cannot be observed anywhere
 * else: that a *partial unique index* — not application logic — is what stops two workers running
 * a turn on one session. An in-memory fake can honour that rule by construction and would prove
 * nothing about the rule holding under two processes.
 *
 * Concurrency here is real and the pool is deliberately wide; with one connection every burst
 * below would be serialized by the driver before the index ever saw it, and every test would pass
 * without testing.
 *
 * Ageing a lease is done by **backdating `lease_expires_at`**, which is the same thing from the
 * index's point of view and takes no waiting.
 *
 * **This file owns `turn_requests`** and truncates it between tests, the way the capacity and rate
 * suites own theirs: a claim reads across every session, so a test of it cannot be scoped to its
 * own rows.
 */

let sql: postgres.Sql;
let db: PostgresJsDatabase;
let queue: PostgresTurnQueue;

beforeAll(() => {
  sql = postgres(inject("postgresUrl"), { max: 24 });
  db = drizzle(sql);
  queue = new PostgresTurnQueue(db);
});

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  await db.delete(turnRequests);
});

/** A user, a project and a session — the three rows a request's foreign keys need. */
async function seedSession(): Promise<{ sessionId: string; userId: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Ada" })
    .returning({ id: users.id });
  const userId = user?.id ?? "";

  const [project] = await db
    .insert(projects)
    .values({ userId, name: "Untitled project", slug: randomUUID() })
    .returning({ id: projects.id });

  const [session] = await db
    .insert(sessions)
    .values({ projectId: project?.id ?? "", title: "one" })
    .returning({ id: sessions.id });

  return { sessionId: session?.id ?? "", userId };
}

async function enqueueTurn(
  seed: { sessionId: string; userId: string },
  message = "build me a thing",
) {
  return await queue.enqueue({
    sessionId: seed.sessionId,
    userId: seed.userId,
    kind: "turn",
    message,
    model: "openai/gpt-5-mini",
    billsToUser: false,
  });
}

async function rowOf(id: string) {
  const [row] = await db.select().from(turnRequests).where(eq(turnRequests.id, id));
  return row;
}

/** Moves a lease's expiry into the past, which is how one is aged without waiting. */
async function expireLease(id: string): Promise<void> {
  await db
    .update(turnRequests)
    .set({ leaseExpiresAt: sqlOf`now() - interval '1 hour'` })
    .where(eq(turnRequests.id, id));
}

describe("enqueue", () => {
  it("writes a queued request and answers with its id", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);

    const row = await rowOf(id);
    expect(row).toMatchObject({
      sessionId: seed.sessionId,
      userId: seed.userId,
      kind: "turn",
      state: "queued",
      message: "build me a thing",
      cancelRequested: false,
      leaseOwner: null,
      leaseExpiresAt: null,
      startedAt: null,
      finishedAt: null,
    });
  });
});

describe("claim", () => {
  it("answers null when nothing is queued", async () => {
    expect(await queue.claim("worker-1")).toBeNull();
  });

  it("leases the request and hands back everything needed to run it", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);

    const claimed = await queue.claim("worker-1");
    expect(claimed).toEqual({
      id,
      sessionId: seed.sessionId,
      userId: seed.userId,
      kind: "turn",
      message: "build me a thing",
      model: "openai/gpt-5-mini",
      billsToUser: false,
    });

    const row = await rowOf(id);
    expect(row?.state).toBe("leased");
    expect(row?.leaseOwner).toBe("worker-1");
    expect(row?.startedAt).not.toBeNull();
    // In the future, or the janitor would reclaim a lease taken a moment ago.
    expect(row?.leaseExpiresAt?.getTime() ?? 0).toBeGreaterThan(Date.now());
  });

  it("takes the oldest queued request first", async () => {
    const first = await seedSession();
    const second = await seedSession();
    const older = await enqueueTurn(first, "first");
    await db
      .update(turnRequests)
      .set({ createdAt: sqlOf`now() - interval '1 minute'` })
      .where(eq(turnRequests.id, older.id));
    await enqueueTurn(second, "second");

    expect((await queue.claim("worker-1"))?.id).toBe(older.id);
  });

  it("leaves a second request on the same session queued while the first is held", async () => {
    const seed = await seedSession();
    const first = await enqueueTurn(seed, "first");
    const second = await enqueueTurn(seed, "second");

    expect((await queue.claim("worker-1"))?.id).toBe(first.id);
    // Not "waits for" — it steps over the session entirely and finds nothing else to do.
    expect(await queue.claim("worker-2")).toBeNull();
    expect((await rowOf(second.id))?.state).toBe("queued");
  });

  it("steps over a busy session to reach a request on a free one", async () => {
    const busy = await seedSession();
    const free = await seedSession();
    await enqueueTurn(busy, "first");
    const blocked = await enqueueTurn(busy, "second");
    await db
      .update(turnRequests)
      .set({ createdAt: sqlOf`now() - interval '1 minute'` })
      .where(eq(turnRequests.id, blocked.id));
    const other = await enqueueTurn(free, "elsewhere");

    await queue.claim("worker-1");
    // The blocked one is older, so a queue that only looked at age would answer null here.
    expect((await queue.claim("worker-2"))?.id).toBe(other.id);
  });

  it("never claims a request that was cancelled while queued", async () => {
    const seed = await seedSession();
    await enqueueTurn(seed);
    await queue.requestCancel(seed.sessionId);

    expect(await queue.claim("worker-1")).toBeNull();
  });

  it("does not re-claim a request that has already been settled", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);
    await queue.claim("worker-1");
    await queue.settle(id, "worker-1", "done");

    expect(await queue.claim("worker-2")).toBeNull();
    expect((await rowOf(id))?.state).toBe("done");
  });

  it("does not re-claim an orphaned request", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);
    await queue.claim("worker-1");
    // What the janitor will do, written directly: this ticket builds the state, not the sweep.
    await db.update(turnRequests).set({ state: "orphaned" }).where(eq(turnRequests.id, id));

    expect(await queue.claim("worker-2")).toBeNull();
  });

  it("gives one session to exactly one of two workers racing for it, unharming the loser", async () => {
    const seed = await seedSession();
    await enqueueTurn(seed, "first");
    await enqueueTurn(seed, "second");

    const [a, b] = await Promise.all([queue.claim("worker-1"), queue.claim("worker-2")]);

    // One lease, and the loser gets an empty answer rather than an error: the other request is
    // untouched and still queued for whenever the session frees up.
    expect([a, b].filter((claim) => claim !== null)).toHaveLength(1);
    const rows = await db
      .select()
      .from(turnRequests)
      .where(eq(turnRequests.sessionId, seed.sessionId));
    expect(rows.filter((row) => row.state === "leased")).toHaveLength(1);
    expect(rows.filter((row) => row.state === "queued")).toHaveLength(1);
  });

  it("moves on to the next candidate when the index refuses one", async () => {
    const busy = await seedSession();
    const free = await seedSession();
    const first = await enqueueTurn(busy, "first");
    await enqueueTurn(busy, "second");
    const elsewhere = await enqueueTurn(free, "elsewhere");

    // The race, made deterministic. A lease on the session is taken and held *uncommitted*, so
    // the candidate query cannot see it — exactly what a worker a microsecond behind another one
    // sees — while the partial unique index can. The claim below therefore picks the second
    // request on the same session, blocks on the index, and is refused the moment this commits.
    let commit = () => {};
    const held = new Promise<void>((resolve) => {
      commit = resolve;
    });
    let taken = () => {};
    const leaseTaken = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const holding = db.transaction(async (tx) => {
      await tx
        .update(turnRequests)
        .set({
          state: "leased",
          leaseOwner: "holder",
          leaseExpiresAt: sqlOf`now() + interval '1 minute'`,
        })
        .where(eq(turnRequests.id, first.id));
      taken();
      await held;
    });

    await leaseTaken;
    const claiming = queue.claim("worker-1");
    // Long enough for the claim to reach the index and block on it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    commit();
    await holding;

    // Not an error, and not an empty answer: the refusal costs one candidate, and the worker goes
    // on to find real work on a session nobody holds.
    expect((await claiming)?.id).toBe(elsewhere.id);
  });

  it("gives a hundred workers a hundred sessions with no collisions", async () => {
    const seeds = await Promise.all(Array.from({ length: 100 }, () => seedSession()));
    await Promise.all(seeds.map((seed) => enqueueTurn(seed)));

    const claims = await Promise.all(
      Array.from({ length: 100 }, (_, index) => queue.claim(`worker-${index}`)),
    );

    const leased = claims.filter((claim) => claim !== null);
    expect(leased).toHaveLength(100);
    // Distinct requests and distinct sessions: the failure this guards is two workers handed the
    // same row, which would show up as a duplicate in either set.
    expect(new Set(leased.map((claim) => claim.id)).size).toBe(100);
    expect(new Set(leased.map((claim) => claim.sessionId)).size).toBe(100);
  });
});

describe("renew", () => {
  it("pushes the expiry out and reports no cancellation", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);
    await queue.claim("worker-1");
    await expireLease(id);

    expect(await queue.renew(id, "worker-1")).toEqual({ held: true, cancelRequested: false });
    expect((await rowOf(id))?.leaseExpiresAt?.getTime() ?? 0).toBeGreaterThan(Date.now());
  });

  it("reports a cancellation in the same answer", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);
    await queue.claim("worker-1");
    await queue.requestCancel(seed.sessionId);

    expect(await queue.renew(id, "worker-1")).toEqual({ held: true, cancelRequested: true });
  });

  it("reports the lease lost to a worker that no longer owns it", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);
    await queue.claim("worker-1");
    // What a janitor reclaiming an expired lease and a second worker taking it looks like from
    // inside the first worker, which is still alive and still thinks it holds the session.
    await db.update(turnRequests).set({ leaseOwner: "worker-2" }).where(eq(turnRequests.id, id));

    expect(await queue.renew(id, "worker-1")).toEqual({ held: false });
  });

  it("reports the lease lost once the request has reached a terminal state", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);
    await queue.claim("worker-1");
    await db.update(turnRequests).set({ state: "orphaned" }).where(eq(turnRequests.id, id));

    // Without the state predicate this would revive a request the janitor had closed out, and the
    // session would hold two writers.
    expect(await queue.renew(id, "worker-1")).toEqual({ held: false });
  });

  it("reports the lease lost for a request that does not exist", async () => {
    expect(await queue.renew(randomUUID(), "worker-1")).toEqual({ held: false });
  });
});

describe("settle", () => {
  it("moves a held request to done and frees the session", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed, "first");
    const next = await enqueueTurn(seed, "second");
    await queue.claim("worker-1");

    expect(await queue.settle(id, "worker-1", "done")).toBe(true);
    const row = await rowOf(id);
    expect(row?.state).toBe("done");
    expect(row?.finishedAt).not.toBeNull();
    // Who ran it stays readable; only `state` decides whether the index applies. The deadline
    // does not — a stale one on a settled row would read as a lease worth reclaiming.
    expect(row?.leaseOwner).toBe("worker-1");
    expect(row?.leaseExpiresAt).toBeNull();
    expect((await queue.claim("worker-2"))?.id).toBe(next.id);
  });

  it("records a failure as its own terminal state", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);
    await queue.claim("worker-1");

    expect(await queue.settle(id, "worker-1", "failed")).toBe(true);
    expect((await rowOf(id))?.state).toBe("failed");
  });

  it("refuses a worker that no longer owns the lease", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);
    await queue.claim("worker-1");
    await db.update(turnRequests).set({ leaseOwner: "worker-2" }).where(eq(turnRequests.id, id));

    // A zombie worker settling somebody else's in-flight request would end a turn that is still
    // running, from a process that has nothing to do with it.
    expect(await queue.settle(id, "worker-1", "done")).toBe(false);
    expect((await rowOf(id))?.state).toBe("leased");
  });
});

describe("requestCancel", () => {
  it("fails a queued request outright, so it can never be claimed", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);

    expect(await queue.requestCancel(seed.sessionId)).toEqual({ cancelled: true, was: "queued" });
    const row = await rowOf(id);
    expect(row?.state).toBe("failed");
    expect(row?.cancelRequested).toBe(true);
    expect(row?.finishedAt).not.toBeNull();
    expect(await queue.claim("worker-1")).toBeNull();
  });

  it("only flags a leased request, leaving the abort to the worker holding it", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);
    await queue.claim("worker-1");

    expect(await queue.requestCancel(seed.sessionId)).toEqual({ cancelled: true, was: "leased" });
    const row = await rowOf(id);
    expect(row?.state).toBe("leased");
    expect(row?.cancelRequested).toBe(true);
  });

  it("reports nothing to cancel when the session is idle", async () => {
    const seed = await seedSession();
    expect(await queue.requestCancel(seed.sessionId)).toEqual({ cancelled: false });
  });

  it("reports nothing to cancel once the request has settled", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);
    await queue.claim("worker-1");
    await queue.settle(id, "worker-1", "done");

    expect(await queue.requestCancel(seed.sessionId)).toEqual({ cancelled: false });
  });

  it("still reports a cancel for a leased request that was already cancelled", async () => {
    const seed = await seedSession();
    await enqueueTurn(seed);
    await queue.claim("worker-1");
    await queue.requestCancel(seed.sessionId);

    // A second click, inside the fifteen seconds before the worker's next renewal. Answering
    // "there is nothing to cancel" would be the opposite of what is true: the turn is running.
    expect(await queue.requestCancel(seed.sessionId)).toEqual({ cancelled: true, was: "leased" });
  });

  it("touches no other session", async () => {
    const mine = await seedSession();
    const theirs = await seedSession();
    const other = await enqueueTurn(theirs);
    await enqueueTurn(mine);

    await queue.requestCancel(mine.sessionId);
    expect((await rowOf(other.id))?.state).toBe("queued");
  });

  it("still reaches a request that is claimed in the same instant", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);

    // The race the single statement exists for: whichever order these land in, the request must
    // end up either failed-while-queued or flagged-while-leased, and never claimed *and* running
    // unaware of the cancellation.
    const [, outcome] = await Promise.all([
      queue.claim("worker-1"),
      queue.requestCancel(seed.sessionId),
    ]);

    expect(outcome.cancelled).toBe(true);
    const row = await rowOf(id);
    expect(row?.cancelRequested).toBe(true);
    if (row?.state === "leased") {
      expect(await queue.renew(id, "worker-1")).toEqual({ held: true, cancelRequested: true });
    } else {
      expect(row?.state).toBe("failed");
    }
  });
});

describe("orphanExpired", () => {
  /** Just past expiry, and well inside the grace: where the worker has yet to notice. */
  async function expireLeaseWithinGrace(id: string): Promise<void> {
    await db
      .update(turnRequests)
      .set({ leaseExpiresAt: sqlOf`now() - interval '5 seconds'` })
      .where(eq(turnRequests.id, id));
  }

  it("leaves an expired lease alone until the grace window has passed", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);
    await queue.claim("worker-1");
    await expireLeaseWithinGrace(id);

    // The fence, not a timeout: the worker learns it is a zombie on its next renewal, and
    // reclaiming before then is what would put two writers on one session.
    expect(await queue.orphanExpired()).toEqual([]);
    expect((await rowOf(id))?.state).toBe("leased");
  });

  it("orphans a lease that ran out longer ago than the grace", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);
    await queue.claim("worker-1");
    await expireLease(id);

    expect(await queue.orphanExpired()).toEqual([{ id, sessionId: seed.sessionId, kind: "turn" }]);

    const row = await rowOf(id);
    expect(row?.state).toBe("orphaned");
    // The marker that its terminal events are still owed, and the record of when its worker
    // went silent.
    expect(row?.finishedAt).toBeNull();
    expect(row?.leaseExpiresAt).not.toBeNull();
  });

  it("holds the session until it orphans, so a zombie never shares it", async () => {
    const seed = await seedSession();
    const first = await enqueueTurn(seed, "first");
    await queue.claim("worker-1");
    const second = await enqueueTurn(seed, "second");
    await expireLease(first.id);

    // The index is over `state = 'leased'` and knows nothing about the clock, which is what
    // keeps the grace window meaningful at all.
    expect(await queue.claim("worker-2")).toBeNull();

    await queue.orphanExpired();
    expect((await queue.claim("worker-2"))?.id).toBe(second.id);
  });

  it("never re-claims an orphaned request", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);
    await queue.claim("worker-1");
    await expireLease(id);
    await queue.orphanExpired();

    expect(await queue.claim("worker-2")).toBeNull();
    expect((await rowOf(id))?.state).toBe("orphaned");
  });

  it("hands a row to exactly one of two janitors running at once", async () => {
    const seeds = await Promise.all(Array.from({ length: 8 }, () => seedSession()));
    const ids: string[] = [];
    for (const seed of seeds) {
      const { id } = await enqueueTurn(seed);
      await queue.claim("worker-1");
      await expireLease(id);
      ids.push(id);
    }

    const sweeps = await Promise.all([
      queue.orphanExpired(),
      queue.orphanExpired(),
      queue.orphanExpired(),
    ]);

    const taken = sweeps.flat().map((request) => request.id);
    expect(taken).toHaveLength(new Set(taken).size);
    // Between them they take everything: `skip locked` steps over a row another janitor holds,
    // and that row is returned to whoever does hold it.
    expect(new Set(taken)).toEqual(new Set(ids));
  });

  it("leaves a request its worker settled alone", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);
    await queue.claim("worker-1");
    await queue.settle(id, "worker-1", "done");
    await expireLease(id);

    expect(await queue.orphanExpired()).toEqual([]);
    expect((await rowOf(id))?.state).toBe("done");
  });

  it("takes no more than the limit in one tick", async () => {
    const seeds = await Promise.all(Array.from({ length: 3 }, () => seedSession()));
    for (const seed of seeds) {
      const { id } = await enqueueTurn(seed);
      await queue.claim("worker-1");
      await expireLease(id);
    }

    expect(await queue.orphanExpired(2)).toHaveLength(2);
    expect(await queue.orphanExpired(2)).toHaveLength(1);
  });
});

describe("unannouncedOrphans", () => {
  it("offers an orphan until its terminal events are recorded as written", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);
    await queue.claim("worker-1");
    await expireLease(id);
    await queue.orphanExpired();

    expect(await queue.unannouncedOrphans()).toEqual([
      { id, sessionId: seed.sessionId, kind: "turn" },
    ]);

    await queue.markOrphanAnnounced(id);
    expect(await queue.unannouncedOrphans()).toEqual([]);
    expect((await rowOf(id))?.finishedAt).not.toBeNull();
  });

  it("refuses a mark for a request that is not an orphan", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);
    // Nothing has been interrupted, so there is nothing to announce. A mark that landed anyway
    // would set the marker on a row that later becomes an orphan, whose terminal events would
    // then never be written.
    await queue.markOrphanAnnounced(id);

    await queue.claim("worker-1");
    await expireLease(id);
    await queue.orphanExpired();

    expect((await queue.unannouncedOrphans()).map((request) => request.id)).toEqual([id]);
  });

  it("offers the longest-abandoned orphan first", async () => {
    const seeds = await Promise.all([seedSession(), seedSession()]);
    const ids: string[] = [];
    for (const seed of seeds) {
      const { id } = await enqueueTurn(seed);
      await queue.claim("worker-1");
      ids.push(id);
    }

    // The first one has been abandoned an hour longer than the second.
    await expireLease(ids[0] ?? "");
    await db
      .update(turnRequests)
      .set({ leaseExpiresAt: sqlOf`now() - interval '5 minutes'` })
      .where(eq(turnRequests.id, ids[1] ?? ""));
    await queue.orphanExpired();

    expect((await queue.unannouncedOrphans()).map((request) => request.id)).toEqual(ids);
  });

  it("ignores everything a worker settled itself", async () => {
    const seed = await seedSession();
    const { id } = await enqueueTurn(seed);
    await queue.claim("worker-1");
    await queue.settle(id, "worker-1", "failed");

    expect(await queue.unannouncedOrphans()).toEqual([]);
  });
});
