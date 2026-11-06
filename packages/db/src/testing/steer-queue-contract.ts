/**
 * What any `SteerQueue` must do, written once and run against both the fake and Postgres.
 *
 * One suite rather than two copies because the worker, the route and the janitor are tested
 * against the fake, and trust it to place a steer where the table would. The one property only
 * Postgres can show — admission racing the end of a request — is tested beside the table, in
 * `postgres-turn-queue.db.test.ts`, because a single-threaded fake honours it by construction.
 */

import type { PlanIntent } from "@nap/shared/agent-plan";
import { MAX_WAITING_STEERS, type SteerQueue } from "@nap/shared/ports/steer-queue";
import type { TurnQueue, TurnRequestKind } from "@nap/shared/ports/turn-queue";
import { describe, expect, it } from "vitest";

export type SteerQueueHarness = {
  queue: TurnQueue & SteerQueue;
  /** A session and its owner the store will accept rows for. Postgres needs real rows. */
  session(): Promise<{ sessionId: string; userId: string }>;
};

type Seed = { sessionId: string; userId: string };

const MODEL = "openai/gpt-5-mini";

export function steerQueueContract(name: string, harness: () => SteerQueueHarness): void {
  describe(`${name} as a SteerQueue`, () => {
    /** Enqueues a request and leases it to `owner`, the way a worker would hold one. */
    async function leased(
      queue: TurnQueue,
      seed: Seed,
      options: { owner?: string; kind?: TurnRequestKind; message?: string; plan?: PlanIntent } = {},
    ): Promise<string> {
      const id = crypto.randomUUID();
      await queue.enqueue({
        id,
        sessionId: seed.sessionId,
        userId: seed.userId,
        kind: options.kind ?? "turn",
        message: options.message ?? "build a habit tracker",
        ...(options.plan === undefined ? {} : { plan: options.plan }),
        model: MODEL,
        billsToUser: false,
      });
      const claimed = await queue.claim(options.owner ?? "worker-a");
      expect(claimed?.id).toBe(id);
      return id;
    }

    function steer(seed: Seed, text = "use Postgres instead", plan?: PlanIntent) {
      return {
        id: crypto.randomUUID(),
        sessionId: seed.sessionId,
        userId: seed.userId,
        message: text,
        ...(plan === undefined ? {} : { plan }),
        model: MODEL,
        billsToUser: true,
      };
    }

    it("joins the request leased on its session, and is read once", async () => {
      const { queue, session } = harness();
      const seed = await session();
      const requestId = await leased(queue, seed);
      const message = steer(seed);

      await expect(queue.steer(message)).resolves.toEqual({ as: "steer", requestId });
      await expect(queue.take(requestId, "worker-a")).resolves.toEqual([
        { id: message.id, text: message.message },
      ]);
      await expect(queue.take(requestId, "worker-a")).resolves.toEqual([]);
      // It joined; it did not queue a turn behind the one running.
      expect(await queue.getStatus({ id: message.id, ...seed })).toBeNull();
    });

    it("is read oldest first, every waiting steer at once", async () => {
      const { queue, session } = harness();
      const seed = await session();
      const requestId = await leased(queue, seed);
      const first = steer(seed, "first");
      const second = steer(seed, "second");
      await queue.steer(first);
      await queue.steer(second);

      const taken = await queue.take(requestId, "worker-a");

      expect(taken.map((one) => one.text)).toEqual(["first", "second"]);
    });

    it("is queued as a turn under its own id when nothing is running", async () => {
      const { queue, session } = harness();
      const seed = await session();
      const message = steer(seed, "add a footer", { intent: "propose" });

      await expect(queue.steer(message)).resolves.toEqual({ as: "turn" });

      const claimed = await queue.claim("worker-a");
      expect(claimed).toEqual({
        id: message.id,
        sessionId: seed.sessionId,
        userId: seed.userId,
        kind: "turn",
        message: "add a footer",
        plan: { intent: "propose" },
        model: MODEL,
        billsToUser: true,
      });
    });

    it("answers a retried id with what the first attempt did, and writes nothing twice", async () => {
      const { queue, session } = harness();
      const seed = await session();
      const requestId = await leased(queue, seed);
      const joined = steer(seed);
      await queue.steer(joined);

      await expect(queue.steer(joined)).resolves.toEqual({ as: "steer", requestId });
      await expect(queue.find(joined)).resolves.toEqual({ as: "steer", requestId });
      await expect(queue.take(requestId, "worker-a")).resolves.toHaveLength(1);

      await queue.settle(requestId, "worker-a", "done");
      const queued = steer(seed, "next");
      await queue.steer(queued);
      await expect(queue.steer(queued)).resolves.toEqual({ as: "turn" });
      await expect(queue.find(queued)).resolves.toEqual({ as: "turn" });
      expect(await queue.claim("worker-a")).toMatchObject({ id: queued.id });
      expect(await queue.claim("worker-b")).toBeNull();
    });

    it("refuses an id that is another session's or another person's", async () => {
      const { queue, session } = harness();
      const mine = await session();
      const theirs = await session();
      const message = steer(theirs);
      await queue.steer(message);

      await expect(queue.steer({ ...message, sessionId: mine.sessionId })).resolves.toEqual({
        as: "conflict",
      });
      await expect(queue.steer({ ...message, userId: mine.userId })).resolves.toEqual({
        as: "conflict",
      });
      await expect(queue.find({ ...message, sessionId: mine.sessionId })).resolves.toEqual({
        as: "conflict",
      });
      await expect(queue.find(steer(mine))).resolves.toBeNull();
    });

    it("does not join a request that is being stopped", async () => {
      const { queue, session } = harness();
      const seed = await session();
      const requestId = await leased(queue, seed);
      await queue.requestCancel(seed.sessionId);

      await expect(queue.steer(steer(seed))).resolves.toEqual({ as: "turn" });
      await expect(queue.take(requestId, "worker-a")).resolves.toEqual([]);
    });

    it("does not join a compaction or an app test", async () => {
      const { queue, session } = harness();
      for (const options of [{ message: "/compact" }, { kind: "test" as const }]) {
        const seed = await session();
        const requestId = await leased(queue, seed, options);
        await expect(queue.steer(steer(seed))).resolves.toEqual({ as: "turn" });
        await queue.settle(requestId, "worker-a", "done");
        // The queued turn, so the next case's claim finds its own request.
        expect(await queue.claim("drain")).not.toBeNull();
      }
    });

    it("joins only a request in its own plan mode", async () => {
      const { queue, session } = harness();
      const planning = await session();
      const planningId = await leased(queue, planning, { plan: { intent: "propose" } });
      await expect(queue.steer(steer(planning))).resolves.toEqual({ as: "turn" });
      await expect(queue.steer(steer(planning, "more", { intent: "propose" }))).resolves.toEqual({
        as: "steer",
        requestId: planningId,
      });

      const building = await session();
      const buildingId = await leased(queue, building, {
        plan: { intent: "approve", planTurnId: planningId },
      });
      await expect(queue.steer(steer(building, "plan it", { intent: "propose" }))).resolves.toEqual(
        { as: "turn" },
      );
      await expect(queue.steer(steer(building))).resolves.toEqual({
        as: "steer",
        requestId: buildingId,
      });
    });

    it(`queues the steer after ${MAX_WAITING_STEERS} waiting ones as a turn`, async () => {
      const { queue, session } = harness();
      const seed = await session();
      const requestId = await leased(queue, seed);
      for (let index = 0; index < MAX_WAITING_STEERS; index += 1)
        await expect(queue.steer(steer(seed, `steer ${index}`))).resolves.toMatchObject({
          as: "steer",
        });

      await expect(queue.steer(steer(seed, "one too many"))).resolves.toEqual({ as: "turn" });

      // Reading them makes room again: the bound is on what waits, not on what a turn may hear.
      await queue.take(requestId, "worker-a");
      await expect(queue.steer(steer(seed, "room again"))).resolves.toEqual({
        as: "steer",
        requestId,
      });
    });

    it("is read only by the worker holding the lease", async () => {
      const { queue, session } = harness();
      const seed = await session();
      const requestId = await leased(queue, seed);
      const message = steer(seed);
      await queue.steer(message);

      await expect(queue.take(requestId, "zombie")).resolves.toEqual([]);
      await expect(queue.close(requestId, "zombie", "drop")).resolves.toEqual({
        deferred: [],
        dropped: [],
      });

      await expect(queue.take(requestId, "worker-a")).resolves.toHaveLength(1);
    });

    it("defers what a finished request never read into the next turn, and closes it", async () => {
      const { queue, session } = harness();
      const seed = await session();
      const planning = { intent: "propose" } as const;
      const requestId = await leased(queue, seed, { plan: planning });
      const read = steer(seed, "read", planning);
      await queue.steer(read);
      await queue.take(requestId, "worker-a");
      const unread = steer(seed, "unread", planning);
      await queue.steer(unread);

      await expect(queue.close(requestId, "worker-a", "defer")).resolves.toEqual({
        deferred: [{ id: unread.id, text: "unread" }],
        dropped: [],
      });

      // Closed: a message now is the next turn, and nothing is left to read.
      const late = steer(seed, "late", planning);
      await expect(queue.steer(late)).resolves.toEqual({ as: "turn" });
      await expect(queue.take(requestId, "worker-a")).resolves.toEqual([]);
      await expect(queue.steersOf(requestId)).resolves.toEqual([
        { id: read.id, text: "read", state: "applied" },
        { id: unread.id, text: "unread", state: "deferred" },
      ]);

      // The deferred steer waits behind the lease like any queued turn, then runs before the late
      // one, which was admitted after it.
      expect(await queue.claim("worker-b")).toBeNull();
      await queue.settle(requestId, "worker-a", "done");
      expect(await queue.claim("worker-b")).toMatchObject({
        id: unread.id,
        kind: "turn",
        message: "unread",
        plan: { intent: "propose" },
        billsToUser: true,
      });
    });

    it("drops what a stopped request never read, and queues nothing", async () => {
      const { queue, session } = harness();
      const seed = await session();
      const requestId = await leased(queue, seed);
      const unread = steer(seed, "unread");
      await queue.steer(unread);

      await expect(queue.close(requestId, "worker-a", "drop")).resolves.toEqual({
        deferred: [],
        dropped: [{ id: unread.id, text: "unread" }],
      });
      await queue.settle(requestId, "worker-a", "failed");

      expect(await queue.claim("worker-b")).toBeNull();
      expect(await queue.getStatus({ id: unread.id, ...seed })).toBeNull();
      await expect(queue.steersOf(requestId)).resolves.toEqual([
        { id: unread.id, text: "unread", state: "dropped" },
      ]);
    });

    it("drops what a request being stopped never read, whatever its worker asked for", async () => {
      // The Stop is in the row before the worker hears of it. A close that deferred here would
      // queue the person's words as a turn the Stop never saw, which would then run and be paid for.
      const { queue, session } = harness();
      const seed = await session();
      const requestId = await leased(queue, seed);
      const unread = steer(seed, "unread");
      await queue.steer(unread);
      await queue.requestCancel(seed.sessionId);

      await expect(queue.close(requestId, "worker-a", "defer")).resolves.toEqual({
        deferred: [],
        dropped: [{ id: unread.id, text: "unread" }],
      });
      expect(await queue.getStatus({ id: unread.id, ...seed })).toBeNull();
      await expect(queue.steersOf(requestId)).resolves.toEqual([
        { id: unread.id, text: "unread", state: "dropped" },
      ]);
    });

    it("hands nothing to a request being stopped", async () => {
      const { queue, session } = harness();
      const seed = await session();
      const requestId = await leased(queue, seed);
      const unread = steer(seed, "unread");
      await queue.steer(unread);
      await queue.requestCancel(seed.sessionId);

      await expect(queue.take(requestId, "worker-a")).resolves.toEqual([]);
      // Still the person's to have back when the stopped request closes.
      await expect(queue.close(requestId, "worker-a", "drop")).resolves.toEqual({
        deferred: [],
        dropped: [{ id: unread.id, text: "unread" }],
      });
    });

    it("resolves nothing twice when a request is closed again", async () => {
      const { queue, session } = harness();
      const seed = await session();
      const requestId = await leased(queue, seed);
      await queue.steer(steer(seed));
      await queue.close(requestId, "worker-a", "defer");

      await expect(queue.close(requestId, "worker-a", "drop")).resolves.toEqual({
        deferred: [],
        dropped: [],
      });
    });

    it("leaves a reclaimed request's waiting steers for the janitor to read", async () => {
      const { queue, session } = harness();
      const seed = await session();
      const requestId = await leased(queue, seed);
      const message = steer(seed);
      await queue.steer(message);

      await expect(queue.steersOf(requestId)).resolves.toEqual([
        { id: message.id, text: message.message, state: "pending" },
      ]);
      await expect(queue.steersOf(crypto.randomUUID())).resolves.toEqual([]);
    });
  });
}
