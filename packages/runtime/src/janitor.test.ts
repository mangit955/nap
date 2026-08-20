import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemoryTurnQueue } from "@nap/db/testing/in-memory-turn-queue";
import type { NapEvent } from "@nap/shared/events";
import { foldJobs } from "@nap/shared/job-state";
import { LEASE_GRACE_MS, LEASE_TTL_MS } from "@nap/shared/lease-windows";
import type { DistributiveOmit, PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import type { TurnQueue } from "@nap/shared/ports/turn-queue";
import { beforeEach, describe, expect, it } from "vitest";
import { continuationFor } from "./continue-job.ts";
import { sweepOrphanedRequests } from "./janitor.ts";

/**
 * What a worker's death looks like from the outside, and the one thing that must never come of
 * it: a Turn with no terminal event.
 *
 * `openEventStream` has no timeout, so a chat pane waiting on an event nobody will ever write
 * spins forever and the user is told nothing at all. Everything here is about closing that — and
 * about **not** closing anything else. The Job stays open, so a human reopening the project is
 * what decides whether the work carries on; re-executing it here would be the autonomous loop
 * `CONTEXT.md`'s *Continue* semantics forbid.
 */

const SESSION = "session-a";
const OTHER_SESSION = "session-b";

let now = 1_000_000;
let queue: InMemoryTurnQueue;
let events: InMemoryEventStore;
let bus: InMemoryEventBus;

beforeEach(() => {
  now = 1_000_000;
  queue = new InMemoryTurnQueue({ now: () => now });
  events = new InMemoryEventStore();
  bus = new InMemoryEventBus();
});

function sweep() {
  return sweepOrphanedRequests({ queue, events, bus, now: () => new Date(now).toISOString() });
}

async function enqueue(sessionId = SESSION, kind: "turn" | "resume" = "turn") {
  return await queue.enqueue({
    sessionId,
    userId: "user-1",
    kind,
    message: kind === "resume" ? null : "build me a thing",
    model: "openai/gpt-5-mini",
    billsToUser: false,
  });
}

/** A request a worker claimed and then died holding. */
async function abandoned(sessionId = SESSION, kind: "turn" | "resume" = "turn") {
  const { id } = await enqueue(sessionId, kind);
  await queue.claim("worker-1");
  return id;
}

/** Past the lease and past the fencing margin, which is when a row becomes reclaimable. */
function pastGrace(): void {
  now += LEASE_TTL_MS + LEASE_GRACE_MS + 1;
}

function logOf(sessionId = SESSION): Promise<StoredEvent[]> {
  return events.readFrom(sessionId, 0);
}

async function typesIn(sessionId = SESSION): Promise<string[]> {
  return (await logOf(sessionId)).map((event) => event.type);
}

/** What a half-run turn leaves behind: a job opened, and nothing that closes it. */
async function partialTurn(turnId: string, sessionId = SESSION): Promise<void> {
  // Distributive, for the reason `PendingEvent` itself is: a plain `Omit` over the union
  // decorrelates `type` from `payload`, and every emission below would then typecheck against
  // any payload at all.
  const emit = async (
    event: DistributiveOmit<PendingEvent, "sessionId" | "turnId" | "createdAt">,
  ) => {
    await events.append({
      ...event,
      sessionId,
      turnId,
      createdAt: new Date(now).toISOString(),
    } as PendingEvent);
  };

  await emit({ type: "turn.started", payload: { source: "user" } });
  await emit({ type: "user.message", payload: { text: "build me a thing" } });
  await emit({ type: "job.started", payload: { jobId: "job-1", objective: "build me a thing" } });
}

describe("orphaning an abandoned request", () => {
  it("writes a terminal event and a notice under the request's own turn id", async () => {
    const id = await abandoned();
    await partialTurn(id);
    pastGrace();

    const result = await sweep();

    expect(result.orphaned).toEqual([id]);
    expect(result.announced).toEqual([id]);
    expect(queue.stateOf(id)).toBe("orphaned");

    const written = (await logOf()).slice(3);
    expect(written.map((event) => event.type)).toEqual(["turn.failed", "system.notice"]);
    // The whole point of `turn_requests.id` being the first Turn's id: the janitor never ran
    // this turn and can still close the right one.
    expect(written.every((event) => event.turnId === id)).toBe(true);
  });

  it("says the work was interrupted, and that reopening resumes it", async () => {
    const id = await abandoned();
    await partialTurn(id);
    pastGrace();
    await sweep();

    const [failed, notice] = (await logOf()).slice(3);
    expect(failed?.type === "turn.failed" && failed.payload.reason).toBe("internal");
    expect(notice?.type === "system.notice" && notice.payload.level).toBe("warning");
    expect(notice?.type === "system.notice" && notice.payload.text).toMatch(/reopen/i);
  });

  it("leaves the Job open, so nobody's work is closed while they are away", async () => {
    const id = await abandoned();
    await partialTurn(id);
    pastGrace();
    await sweep();

    expect(await typesIn()).not.toContain("job.completed");

    // What a human reopening the project would be offered. `none` here would mean the work was
    // silently dropped rather than waiting.
    const continuation = continuationFor(foldJobs(await logOf()));
    expect(continuation.kind).not.toBe("none");
  });

  it("closes out an abandoned resume the same way", async () => {
    const id = await abandoned(SESSION, "resume");
    pastGrace();
    await sweep();

    expect(queue.stateOf(id)).toBe("orphaned");
    expect(await typesIn()).toEqual(["turn.failed", "system.notice"]);
  });

  it("publishes what it appends, so an open tab hears without reconnecting", async () => {
    const id = await abandoned();
    const heard: NapEvent[] = [];
    bus.subscribe(SESSION, (event) => heard.push(event));
    await partialTurn(id);
    pastGrace();
    await sweep();

    expect(heard.map((event) => event.type)).toEqual(["turn.failed", "system.notice"]);
  });
});

describe("what it refuses to touch", () => {
  it("leaves a lease that expired inside the grace window alone", async () => {
    const id = await abandoned();
    // Expired, but the worker only learns that on its next renewal. Acting here is what would
    // put two writers on one session.
    now += LEASE_TTL_MS + 1;

    const result = await sweep();

    expect(result.orphaned).toEqual([]);
    expect(queue.stateOf(id)).toBe("leased");
    expect(await logOf()).toEqual([]);
  });

  it("leaves a request its worker settled itself alone", async () => {
    const id = await abandoned();
    await queue.settle(id, "worker-1", "done");
    pastGrace();

    await sweep();

    expect(queue.stateOf(id)).toBe("done");
    expect(await logOf()).toEqual([]);
  });

  it("never requeues, so nothing re-executes with nobody watching", async () => {
    const id = await abandoned();
    pastGrace();
    await sweep();

    expect(await queue.claim("worker-2")).toBeNull();
    expect(queue.stateOf(id)).toBe("orphaned");
  });
});

describe("a zombie worker and the continuation that follows it", () => {
  it("never produces two turn.started events for one request", async () => {
    const zombie = await abandoned();
    await partialTurn(zombie);
    pastGrace();
    await sweep();

    // The human comes back and reopens the project, which is a queued resume with an id of its
    // own. The zombie's request is terminal and unclaimable, so the only way the log could hold
    // two `turn.started` under one id is if something requeued it.
    const resume = await enqueue(SESSION, "resume");
    const claimed = await queue.claim("worker-2");
    expect(claimed?.id).toBe(resume.id);
    await partialTurn(resume.id);

    // Meanwhile the zombie finally wakes up. Both of its writes to the queue are conditional on
    // a lease it no longer holds, so neither lands.
    expect(await queue.renew(zombie, "worker-1")).toEqual({ held: false });
    expect(await queue.settle(zombie, "worker-1", "done")).toBe(false);

    const starts = (await logOf()).filter((event) => event.type === "turn.started");
    expect(starts.map((event) => event.turnId)).toEqual([zombie, resume.id]);
    expect(queue.stateOf(zombie)).toBe("orphaned");
  });
});

describe("when the announcement does not get through", () => {
  it("finishes the job on a later tick rather than leaving a request unclosed", async () => {
    const id = await abandoned();
    pastGrace();

    // The append fails: the janitor dies, or Postgres blinks, between taking the row and writing
    // the events. The row is terminal and the chat pane is still spinning on an event nobody
    // will ever write, so the next tick has to finish the job.
    const failing = {
      append: () => Promise.reject(new Error("no connection")),
      readFrom: events.readFrom.bind(events),
    };
    const first = await sweepOrphanedRequests({
      queue,
      events: failing,
      bus,
      now: () => new Date(now).toISOString(),
    });

    expect(first.orphaned).toEqual([id]);
    expect(first.announced).toEqual([]);
    expect(first.failed).toHaveLength(1);

    const second = await sweep();
    expect(second.orphaned).toEqual([]);
    expect(second.announced).toEqual([id]);
    expect(await typesIn()).toEqual(["turn.failed", "system.notice"]);
  });

  it("keeps the orphan owed when the mark itself fails", async () => {
    const id = await abandoned();
    pastGrace();

    // Everything is durable and only the bookkeeping failed. The next tick sees an orphan still
    // owed its events and writes them again — a second terminal event in a chat pane is untidy,
    // and no terminal event at all is a pane that never stops.
    const flaky: TurnQueue = {
      orphanExpired: (limit) => queue.orphanExpired(limit),
      unannouncedOrphans: (limit) => queue.unannouncedOrphans(limit),
      markOrphanAnnounced: () => Promise.reject(new Error("no connection")),
      enqueue: (request) => queue.enqueue(request),
      claim: (owner) => queue.claim(owner),
      renew: (requestId, owner) => queue.renew(requestId, owner),
      settle: (requestId, owner, state) => queue.settle(requestId, owner, state),
      requestCancel: (sessionId) => queue.requestCancel(sessionId),
    };

    const result = await sweepOrphanedRequests({
      queue: flaky,
      events,
      bus,
      now: () => new Date(now).toISOString(),
    });

    expect(result.announced).toEqual([]);
    expect(result.failed).toEqual([{ requestId: id, message: "no connection" }]);
    expect(await queue.unannouncedOrphans()).toHaveLength(1);
  });

  it("reports a queue it could not ask at all, without a request to blame", async () => {
    const unreachable: TurnQueue = {
      orphanExpired: () => Promise.reject(new Error("the database went away")),
      unannouncedOrphans: () => Promise.reject(new Error("the database went away")),
      enqueue: (request) => queue.enqueue(request),
      claim: (owner) => queue.claim(owner),
      renew: (requestId, owner) => queue.renew(requestId, owner),
      settle: (requestId, owner, state) => queue.settle(requestId, owner, state),
      requestCancel: (sessionId) => queue.requestCancel(sessionId),
      markOrphanAnnounced: (requestId) => queue.markOrphanAnnounced(requestId),
    };

    const result = await sweepOrphanedRequests({ queue: unreachable, events, bus });

    // Both halves failed, and neither was about a particular request. Nothing throws: an
    // unhandled rejection here would end the process that every open tab is connected to.
    expect(result.failed.map((failure) => failure.requestId)).toEqual([null, null]);
  });

  it("announces an orphan once and not again", async () => {
    const id = await abandoned();
    pastGrace();
    await sweep();
    await sweep();

    expect((await typesIn()).filter((type) => type === "turn.failed")).toHaveLength(1);
    expect(queue.stateOf(id)).toBe("orphaned");
  });

  it("carries on to the next request when one session's append fails", async () => {
    await abandoned(SESSION);
    const other = await abandoned(OTHER_SESSION);
    pastGrace();

    const store = {
      append: (event: PendingEvent) =>
        event.sessionId === SESSION
          ? Promise.reject(new Error("no connection"))
          : events.append(event),
      readFrom: events.readFrom.bind(events),
    };

    const result = await sweepOrphanedRequests({
      queue,
      events: store,
      bus,
      now: () => new Date(now).toISOString(),
    });

    // The session that failed is the one most likely to fail again next tick; giving up on the
    // rest would leave every other pane spinning too.
    expect(result.announced).toEqual([other]);
    expect(result.failed).toHaveLength(1);
  });
});

/**
 * A deterministic generator, so a failing run is reproducible from its seed.
 *
 * `Math.random()` in a property test buys the same coverage and loses the only thing that makes a
 * failure worth having: the ability to run it again. Mulberry32 — small, uniform enough for
 * choosing branches, and the whole of it fits here.
 */
function randomsFrom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the invariant, over random crash points", () => {
  it("leaves nothing a worker was holding non-terminal past the lease and the grace", async () => {
    // Every place a worker can stop: before claiming, mid-turn holding a lease, after settling,
    // and after being cancelled. Whatever the mix, one sweep past the window closes everything
    // no worker is running any more, and every one it closed has its terminal event.
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = randomsFrom(seed);
      now = 1_000_000;
      queue = new InMemoryTurnQueue({ now: () => now });
      events = new InMemoryEventStore();
      bus = new InMemoryEventBus();

      const claimed: { id: string; sessionId: string }[] = [];
      const untouched: string[] = [];

      for (let index = 0; index < 1 + Math.floor(random() * 5); index += 1) {
        const sessionId = `session-${index}`;
        const { id } = await enqueue(sessionId);
        const crashAt = random();

        // Died before anything claimed it: still queued, and a polling worker will take it.
        if (crashAt < 0.25) {
          untouched.push(id);
          continue;
        }

        // Whatever the queue gave, rather than what was just enqueued: an earlier round may have
        // left an older request unclaimed, and that one is what a worker takes first.
        const taken = await queue.claim(`worker-${index}`);
        if (taken === null) continue;
        claimed.push({ id: taken.id, sessionId: taken.sessionId });
        const wasQueued = untouched.indexOf(taken.id);
        if (wasQueued !== -1) untouched.splice(wasQueued, 1);

        if (crashAt < 0.5) continue; // died holding the lease
        if (crashAt < 0.75) await queue.settle(taken.id, `worker-${index}`, "done");
        else await queue.requestCancel(taken.sessionId);
      }

      pastGrace();
      await sweep();

      for (const request of claimed) {
        // The invariant: nothing a worker was holding is still `leased` past the lease and the
        // grace, whatever the worker was doing when it stopped.
        const state = queue.stateOf(request.id);
        expect(state === "orphaned" || state === "done" || state === "failed").toBe(true);

        // And everything the janitor closed has the terminal event that stops its chat pane.
        if (state === "orphaned") {
          expect(await typesIn(request.sessionId)).toEqual(["turn.failed", "system.notice"]);
        }
      }

      for (const id of untouched) {
        // A request nobody claimed was never interrupted. Orphaning it would be the janitor
        // failing work that is simply waiting its turn. (Cancelling its session is the one other
        // way it can end, and that is somebody asking.)
        expect(queue.stateOf(id)).not.toBe("orphaned");
      }
    }
  });
});
