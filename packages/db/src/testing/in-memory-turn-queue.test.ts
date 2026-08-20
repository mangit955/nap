import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryTurnQueue } from "./in-memory-turn-queue.ts";

/**
 * The fake is production-quality code that every worker test depends on, so it is tested for the
 * same behaviours the real one is — minus the concurrency, which is the whole reason the real one
 * has its own suite against a real Postgres.
 */

let now = 1_000;
let queue: InMemoryTurnQueue;

beforeEach(() => {
  now = 1_000;
  queue = new InMemoryTurnQueue({ now: () => now, leaseTtlMs: 60_000 });
});

function enqueue(sessionId: string, message = "do a thing") {
  return queue.enqueue({
    sessionId,
    userId: "user-1",
    kind: "turn",
    message,
    model: "openai/gpt-5-mini",
    billsToUser: false,
  });
}

describe("claim", () => {
  it("answers null when nothing is queued", async () => {
    expect(await queue.claim("worker-1")).toBeNull();
  });

  it("leases the oldest request and hands back what is needed to run it", async () => {
    const first = await enqueue("session-a", "first");
    await enqueue("session-b", "second");

    expect(await queue.claim("worker-1")).toEqual({
      id: first.id,
      sessionId: "session-a",
      userId: "user-1",
      kind: "turn",
      message: "first",
      model: "openai/gpt-5-mini",
      billsToUser: false,
    });
  });

  it("holds one session at a time and steps over it to reach another", async () => {
    await enqueue("session-a", "first");
    await enqueue("session-a", "second");
    const elsewhere = await enqueue("session-b", "elsewhere");

    await queue.claim("worker-1");
    expect((await queue.claim("worker-2"))?.id).toBe(elsewhere.id);
    expect(await queue.claim("worker-3")).toBeNull();
  });

  it("lets the session be claimed again once the janitor has reclaimed the lease", async () => {
    await enqueue("session-a", "first");
    const second = await enqueue("session-a", "second");
    await queue.claim("worker-1");

    // Expiry alone frees nothing: the partial unique index in Postgres is over `state = 'leased'`
    // and knows nothing about the clock, and the worker that holds it may not have learned it is
    // a zombie yet. Only the janitor, past the grace window, moves the row out.
    now += 60_001;
    expect(await queue.claim("worker-2")).toBeNull();

    now += 30_000;
    await queue.orphanExpired();
    expect((await queue.claim("worker-2"))?.id).toBe(second.id);
  });

  it("never claims a cancelled request, and never re-claims a settled one", async () => {
    const cancelled = await enqueue("session-a");
    await queue.requestCancel("session-a");
    expect(await queue.claim("worker-1")).toBeNull();
    expect(queue.stateOf(cancelled.id)).toBe("failed");

    const settled = await enqueue("session-b");
    await queue.claim("worker-1");
    await queue.settle(settled.id, "worker-1", "done");
    expect(await queue.claim("worker-2")).toBeNull();
  });
});

describe("renew", () => {
  it("pushes the expiry out and reports no cancellation", async () => {
    const { id } = await enqueue("session-a");
    await queue.claim("worker-1");
    now += 30_000;

    expect(await queue.renew(id, "worker-1")).toEqual({ held: true, cancelRequested: false });
    now += 59_000;
    expect(await queue.renew(id, "worker-1")).toEqual({ held: true, cancelRequested: false });
  });

  it("reports a cancellation in the same answer", async () => {
    const { id } = await enqueue("session-a");
    await queue.claim("worker-1");
    await queue.requestCancel("session-a");

    expect(await queue.renew(id, "worker-1")).toEqual({ held: true, cancelRequested: true });
  });

  it("reports the lease lost once somebody else owns it", async () => {
    const { id } = await enqueue("session-a");
    await queue.claim("worker-1");
    queue.stealLease(id, "worker-2");

    expect(await queue.renew(id, "worker-1")).toEqual({ held: false });
  });

  it("reports the lease lost once the request has settled", async () => {
    const { id } = await enqueue("session-a");
    await queue.claim("worker-1");
    await queue.settle(id, "worker-1", "done");

    expect(await queue.renew(id, "worker-1")).toEqual({ held: false });
  });
});

describe("settle", () => {
  it("refuses a worker that no longer owns the lease", async () => {
    const { id } = await enqueue("session-a");
    await queue.claim("worker-1");
    queue.stealLease(id, "worker-2");

    expect(await queue.settle(id, "worker-1", "done")).toBe(false);
    expect(queue.stateOf(id)).toBe("leased");
  });
});

describe("requestCancel", () => {
  it("fails a queued request and only flags a leased one", async () => {
    const leased = await enqueue("session-a");
    await queue.claim("worker-1");
    expect(await queue.requestCancel("session-a")).toEqual({ cancelled: true, was: "leased" });
    expect(queue.stateOf(leased.id)).toBe("leased");

    const queued = await enqueue("session-b");
    expect(await queue.requestCancel("session-b")).toEqual({ cancelled: true, was: "queued" });
    expect(queue.stateOf(queued.id)).toBe("failed");
  });

  it("still reports a cancel for a leased request that was already cancelled", async () => {
    await enqueue("session-a");
    await queue.claim("worker-1");
    await queue.requestCancel("session-a");

    // The turn is still running until its next renewal, so a second click must not be told
    // otherwise.
    expect(await queue.requestCancel("session-a")).toEqual({ cancelled: true, was: "leased" });
  });

  it("reports nothing to cancel on an idle session", async () => {
    expect(await queue.requestCancel("session-a")).toEqual({ cancelled: false });
  });
});

describe("orphanExpired", () => {
  it("leaves a lease alone until the grace window has passed", async () => {
    const { id } = await enqueue("session-a");
    await queue.claim("worker-1");

    // Expired, but the worker may not have learned that yet: it finds out on its next renewal.
    now += 60_000 + 1;
    expect(await queue.orphanExpired()).toEqual([]);
    expect(queue.stateOf(id)).toBe("leased");

    now += 30_000;
    expect(await queue.orphanExpired()).toEqual([{ id, sessionId: "session-a", kind: "turn" }]);
    expect(queue.stateOf(id)).toBe("orphaned");
  });

  it("holds the session until it orphans, so a zombie never shares it", async () => {
    await enqueue("session-a");
    await queue.claim("worker-1");
    await enqueue("session-a");

    // The lease has run out but nothing has reclaimed it. The index in Postgres is over the
    // state alone, and the second request must wait for the same reason here.
    now += 60_000 + 1;
    expect(await queue.claim("worker-2")).toBeNull();

    now += 30_000;
    await queue.orphanExpired();
    expect(await queue.claim("worker-2")).not.toBeNull();
  });

  it("never re-claims an orphaned request", async () => {
    const { id } = await enqueue("session-a");
    await queue.claim("worker-1");
    now += 90_001;
    await queue.orphanExpired();

    expect(await queue.claim("worker-2")).toBeNull();
    expect(queue.stateOf(id)).toBe("orphaned");
  });

  it("takes a row once, so two janitors do not both close it out", async () => {
    await enqueue("session-a");
    await queue.claim("worker-1");
    now += 90_001;

    expect(await queue.orphanExpired()).toHaveLength(1);
    expect(await queue.orphanExpired()).toEqual([]);
  });

  it("does not touch a settled request", async () => {
    const { id } = await enqueue("session-a");
    await queue.claim("worker-1");
    await queue.settle(id, "worker-1", "done");
    now += 90_001;

    expect(await queue.orphanExpired()).toEqual([]);
    expect(queue.stateOf(id)).toBe("done");
  });
});

describe("unannouncedOrphans", () => {
  it("offers an orphan until its terminal events are recorded as written", async () => {
    const { id } = await enqueue("session-a");
    await queue.claim("worker-1");
    now += 90_001;
    await queue.orphanExpired();

    // A janitor that died between orphaning and appending would otherwise leave a request that
    // is terminal here and still spinning in somebody's chat pane.
    expect(await queue.unannouncedOrphans()).toEqual([
      { id, sessionId: "session-a", kind: "turn" },
    ]);

    await queue.markOrphanAnnounced(id);
    expect(await queue.unannouncedOrphans()).toEqual([]);
  });

  it("ignores requests a worker settled itself", async () => {
    const { id } = await enqueue("session-a");
    await queue.claim("worker-1");
    await queue.settle(id, "worker-1", "failed");

    expect(await queue.unannouncedOrphans()).toEqual([]);
  });
});

describe("markOrphanAnnounced", () => {
  it("refuses a request that is not an orphan", async () => {
    const { id } = await enqueue("session-a");
    // Nothing has been interrupted, so there is nothing to announce. A mark that landed anyway
    // would set the marker on a row that later becomes an orphan, and its terminal events would
    // then never be written.
    await queue.markOrphanAnnounced(id);

    await queue.claim("worker-1");
    now += 90_001;
    await queue.orphanExpired();

    expect((await queue.unannouncedOrphans()).map((request) => request.id)).toEqual([id]);
  });

  it("offers the longest-abandoned orphan first", async () => {
    const first = await enqueue("session-a");
    await queue.claim("worker-1");
    now += 10_000;
    const second = await enqueue("session-b");
    await queue.claim("worker-2");

    now += 90_001;
    await queue.orphanExpired();

    expect((await queue.unannouncedOrphans()).map((request) => request.id)).toEqual([
      first.id,
      second.id,
    ]);
  });
});
