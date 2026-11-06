import type { InMemoryProjectComputerAccess } from "./in-memory-project-computer-access.ts";
/**
 * The turn queue in one process, for tests of everything that sits *on* it.
 *
 * It honours the same rules the Postgres one does — one lease per session, no path back to
 * `queued`, renewal conditional on the owner — but it honours them by construction, in a single
 * thread, which is exactly why it proves nothing about them. The rules are properties of a
 * partial unique index under concurrency, and `postgres-turn-queue.db.test.ts` is where they are
 * tested. What this is for is the worker loop: what a worker does when a renewal says its lease is
 * gone should not need a database to assert.
 *
 * **The clock is injectable**, so a test of lease expiry is arithmetic rather than a wait. The
 * Postgres one takes no clock at all, for the reason the rate limiter does not: the only clock
 * every process agrees on is the store's own.
 */

import { LEASE_GRACE_MS, LEASE_TTL_MS, ORPHAN_SWEEP_LIMIT } from "@nap/shared/lease-windows";
import {
  type ClosedSteers,
  MAX_WAITING_STEERS,
  type Steer,
  type SteerAdmission,
  type SteerQueue,
  type SteerRequest,
  type SteerState,
} from "@nap/shared/ports/steer-queue";
import type {
  CancelOutcome,
  EnqueueTurnRequest,
  LeasedTurnRequest,
  LeaseRenewal,
  OrphanedTurnRequest,
  TurnQueue,
  TurnRequestSettlement,
  TurnRequestState,
  TurnRequestStatus,
} from "@nap/shared/ports/turn-queue";

type Row = EnqueueTurnRequest & {
  state: TurnRequestState;
  cancelRequested: boolean;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  /** When this row's terminal events reached the log. Null on an orphan nobody has announced. */
  finishedAt: number | null;
  /** Set once the worker has resolved this request's steers; nothing joins it after. */
  steeringClosed: boolean;
};

type SteerRow = Omit<SteerRequest, "message"> & {
  text: string;
  requestId: string;
  state: SteerState;
  /** When it was sent, which is also where a turn it falls back to sorts in the queue. */
  createdAt: number;
};

export type InMemoryTurnQueueOptions = {
  /** Milliseconds since the epoch. Defaults to the real clock. */
  now?: () => number;
  /** How long a claim is good for. Defaults to the shared lease TTL. */
  leaseTtlMs?: number;
  /** How long past expiry the janitor waits. Defaults to the shared grace. */
  leaseGraceMs?: number;
};

export class InMemoryTurnQueue implements TurnQueue, SteerQueue {
  readonly #rows: Row[] = [];
  /** Oldest first, which is the order a request reads them in. */
  readonly #steers: SteerRow[] = [];
  readonly #now: () => number;
  readonly #leaseTtlMs: number;
  readonly #leaseGraceMs: number;
  #sequence = 0;
  #computer: InMemoryProjectComputerAccess | undefined;
  attachComputerAccess(access: InMemoryProjectComputerAccess): void {
    this.#computer = access;
  }
  computerLeases(): readonly Row[] {
    return this.#rows.filter((row) => row.state === "leased");
  }

  constructor(options: InMemoryTurnQueueOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#leaseTtlMs = options.leaseTtlMs ?? LEASE_TTL_MS;
    this.#leaseGraceMs = options.leaseGraceMs ?? LEASE_GRACE_MS;
  }

  async enqueue(request: EnqueueTurnRequest): Promise<void> {
    // The primary key, as in Postgres: a request's id is a message's identity, and a second row
    // under it would be the same words run twice.
    if (this.#rows.some((row) => row.id === request.id))
      throw new Error(`a turn request already has the id ${request.id}`);
    this.#sequence += 1;
    this.#rows.push({
      // The caller's, as in Postgres: it is the first Turn's id and had to exist before this row.
      id: request.id,
      sessionId: request.sessionId,
      userId: request.userId,
      kind: request.kind,
      message: request.message,
      ...(request.attachments === undefined
        ? {}
        : { attachments: structuredClone(request.attachments) }),
      ...(request.plan === undefined ? {} : { plan: structuredClone(request.plan) }),
      model: request.model,
      billsToUser: request.billsToUser,
      state: "queued",
      cancelRequested: false,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: null,
      steeringClosed: false,
      // The sequence, not the clock: two requests enqueued in the same millisecond still have an
      // order, and a test that injected a frozen clock would otherwise have none.
      createdAt: this.#sequence,
    });
  }

  async getStatus(request: {
    id: string;
    sessionId: string;
    userId: string;
  }): Promise<TurnRequestStatus | null> {
    const row = this.#rows.find(
      (row) =>
        row.id === request.id &&
        row.sessionId === request.sessionId &&
        row.userId === request.userId,
    );
    return row === undefined ? null : { id: row.id, state: row.state };
  }

  async hasPending(sessionId: string): Promise<boolean> {
    return this.#rows.some(
      (row) => row.sessionId === sessionId && (row.state === "queued" || row.state === "leased"),
    );
  }

  async claim(owner: string): Promise<LeasedTurnRequest | null> {
    const held = new Set(
      this.#rows.filter((row) => this.#isLeased(row)).map((row) => row.sessionId),
    );

    const candidate = this.#rows
      .filter(
        (row) =>
          row.state === "queued" &&
          !row.cancelRequested &&
          !held.has(row.sessionId) &&
          !this.#computer?.blocked(
            this.#computer.projectForSession(row.sessionId)?.projectId ?? "",
          ),
      )
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (candidate === undefined) return null;

    candidate.state = "leased";
    this.#computer?.claimed(candidate.sessionId);
    candidate.leaseOwner = owner;
    candidate.leaseExpiresAt = this.#now() + this.#leaseTtlMs;

    return {
      id: candidate.id,
      sessionId: candidate.sessionId,
      userId: candidate.userId,
      kind: candidate.kind,
      message: candidate.message,
      ...(candidate.attachments === undefined
        ? {}
        : { attachments: structuredClone(candidate.attachments) }),
      ...(candidate.plan === undefined ? {} : { plan: structuredClone(candidate.plan) }),
      model: candidate.model,
      billsToUser: candidate.billsToUser,
    };
  }

  async renew(requestId: string, owner: string): Promise<LeaseRenewal> {
    const row = this.#rows.find(
      (candidate) =>
        candidate.id === requestId &&
        candidate.leaseOwner === owner &&
        candidate.state === "leased",
    );
    if (row === undefined) return { held: false };

    row.leaseExpiresAt = this.#now() + this.#leaseTtlMs;
    return { held: true, cancelRequested: row.cancelRequested };
  }

  async settle(requestId: string, owner: string, state: TurnRequestSettlement): Promise<boolean> {
    const row = this.#rows.find(
      (candidate) =>
        candidate.id === requestId &&
        candidate.leaseOwner === owner &&
        candidate.state === "leased",
    );
    if (row === undefined) return false;

    row.state = state;
    row.leaseExpiresAt = null;
    row.finishedAt = this.#now();
    return true;
  }

  async anyLeased(sessionIds: readonly string[]): Promise<boolean> {
    const asked = new Set(sessionIds);
    return this.#rows.some((row) => asked.has(row.sessionId) && this.#isLeased(row));
  }

  async requestCancel(sessionId: string): Promise<CancelOutcome> {
    // Already-cancelled rows still match, as they do in Postgres: a second click on a turn that
    // is still running must not be told there is nothing to cancel.
    const rows = this.#rows.filter(
      (row) => row.sessionId === sessionId && (row.state === "queued" || row.state === "leased"),
    );
    if (rows.length === 0) return { cancelled: false };

    let leasedId: string | null = null;
    for (const row of rows) {
      row.cancelRequested = true;
      if (row.state === "leased") leasedId = row.id;
      else {
        row.state = "failed";
        row.finishedAt = this.#now();
      }
    }
    return leasedId === null
      ? { cancelled: true, was: "queued" }
      : { cancelled: true, was: "leased", requestId: leasedId };
  }

  async orphanExpired(limit = ORPHAN_SWEEP_LIMIT): Promise<OrphanedTurnRequest[]> {
    // The fence: expiry alone is not enough, because a worker only learns it lost its lease on
    // its next renewal. See `@nap/shared/lease-windows`.
    const reclaimable = this.#now() - this.#leaseGraceMs;

    const expired = this.#rows
      .filter((row) => row.state === "leased" && (row.leaseExpiresAt ?? 0) < reclaimable)
      .sort((a, b) => (a.leaseExpiresAt ?? 0) - (b.leaseExpiresAt ?? 0))
      .slice(0, limit);

    for (const row of expired) row.state = "orphaned";
    // `finishedAt` deliberately stays null: it is the marker saying the terminal events are not
    // in the log yet, which is what `unannouncedOrphans` reads.
    return expired.map(asOrphan);
  }

  async unannouncedOrphans(limit = ORPHAN_SWEEP_LIMIT): Promise<OrphanedTurnRequest[]> {
    return this.#rows
      .filter((row) => row.state === "orphaned" && row.finishedAt === null)
      .slice(0, limit)
      .map(asOrphan);
  }

  async markOrphanAnnounced(requestId: string): Promise<void> {
    // Conditional on the state, as the real statement is: only an orphan is terminal with a null
    // `finishedAt`, so nothing else may be marked through this door.
    const row = this.#rows.find(
      (candidate) => candidate.id === requestId && candidate.state === "orphaned",
    );
    if (row !== undefined) row.finishedAt = this.#now();
  }

  async steer(request: SteerRequest): Promise<SteerAdmission> {
    const earlier = await this.find(request);
    if (earlier !== null) return earlier;

    // The same conditions the Postgres statement holds the row for. Single-threaded, so checking
    // and inserting cannot be split by a close the way two statements could be.
    const target = this.#rows.find(
      (row) =>
        row.sessionId === request.sessionId &&
        row.state === "leased" &&
        row.kind === "turn" &&
        row.message?.trim() !== "/compact" &&
        !row.cancelRequested &&
        !row.steeringClosed &&
        (row.plan?.intent === "propose") === (request.plan?.intent === "propose") &&
        this.#steers.filter((one) => one.requestId === row.id && one.state === "pending").length <
          MAX_WAITING_STEERS,
    );
    if (target === undefined) {
      await this.enqueue({ ...request, kind: "turn" });
      return { as: "turn" };
    }

    const { message, ...rest } = request;
    this.#sequence += 1;
    this.#steers.push({
      createdAt: this.#sequence,
      ...rest,
      ...(request.plan === undefined ? {} : { plan: structuredClone(request.plan) }),
      text: message,
      requestId: target.id,
      state: "pending",
    });
    return { as: "steer", requestId: target.id };
  }

  async find(
    request: Pick<SteerRequest, "id" | "sessionId" | "userId">,
  ): Promise<SteerAdmission | null> {
    const steer = this.#steers.find((one) => one.id === request.id);
    const turn = this.#rows.find((row) => row.id === request.id);
    const found = steer ?? turn;
    if (found === undefined) return null;
    if (found.sessionId !== request.sessionId || found.userId !== request.userId)
      return { as: "conflict" };
    return steer === undefined ? { as: "turn" } : { as: "steer", requestId: steer.requestId };
  }

  async take(requestId: string, owner: string): Promise<Steer[]> {
    // A request being stopped reads nothing more, as in Postgres.
    if (this.#held(requestId, owner)?.cancelRequested !== false) return [];
    const waiting = this.#steers.filter(
      (one) => one.requestId === requestId && one.state === "pending",
    );
    for (const one of waiting) one.state = "applied";
    return waiting.map(asSteer);
  }

  async close(
    requestId: string,
    owner: string,
    disposition: "defer" | "drop",
  ): Promise<ClosedSteers> {
    const request = this.#held(requestId, owner);
    if (request === undefined || request.steeringClosed) return { deferred: [], dropped: [] };
    request.steeringClosed = true;
    // A Stop recorded on the row wins over what the worker asked, as in Postgres.
    const resolution = request.cancelRequested ? "drop" : disposition;

    const waiting = this.#steers.filter(
      (one) => one.requestId === requestId && one.state === "pending",
    );
    for (const one of waiting) {
      one.state = resolution === "defer" ? "deferred" : "dropped";
      // Already a turn under this id is this message already queued, as Postgres's
      // `on conflict do nothing` treats it.
      if (resolution === "defer" && !this.#rows.some((row) => row.id === one.id)) {
        await this.enqueue({
          id: one.id,
          sessionId: one.sessionId,
          userId: one.userId,
          kind: "turn",
          message: one.text,
          ...(one.plan === undefined ? {} : { plan: structuredClone(one.plan) }),
          model: one.model,
          billsToUser: one.billsToUser,
        });
        // Queued in the order it was sent rather than the order it was resolved in, as Postgres
        // does: several deferred at once would otherwise have no order between them.
        const queued = this.#rows.at(-1);
        if (queued !== undefined) queued.createdAt = one.createdAt;
      }
    }
    const resolved = waiting.map(asSteer);
    return resolution === "defer"
      ? { deferred: resolved, dropped: [] }
      : { deferred: [], dropped: resolved };
  }

  async steersOf(requestId: string): Promise<(Steer & { state: SteerState })[]> {
    return this.#steers
      .filter((one) => one.requestId === requestId)
      .map((one) => ({ ...asSteer(one), state: one.state }));
  }

  /** The request, if `owner` holds its lease — the predicate every steering write is under. */
  #held(requestId: string, owner: string): Row | undefined {
    return this.#rows.find(
      (row) => row.id === requestId && row.leaseOwner === owner && row.state === "leased",
    );
  }

  /** What state a request is in, for tests that assert on the queue rather than through it. */
  stateOf(requestId: string): TurnRequestState | null {
    return this.#rows.find((row) => row.id === requestId)?.state ?? null;
  }

  /**
   * How many requests are neither settled nor abandoned.
   *
   * What a test waits on when it wants "and then everything finished": a worker is a polling
   * loop, so the alternative is a fixed sleep long enough to be slow and short enough to be
   * flaky. Zero means every request reached a terminal state, whichever one.
   */
  get inFlight(): number {
    return this.#rows.filter((row) => row.state === "queued" || row.state === "leased").length;
  }

  /**
   * Everything ever enqueued, oldest first.
   *
   * What an admission test asserts on: the route's whole job is now to write one of these down
   * correctly — the right prompt, the model it resolved, and *whether* the asker pays.
   */
  get enqueued(): readonly EnqueueTurnRequest[] {
    return this.#rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      userId: row.userId,
      kind: row.kind,
      message: row.message,
      ...(row.attachments === undefined ? {} : { attachments: structuredClone(row.attachments) }),
      ...(row.plan === undefined ? {} : { plan: structuredClone(row.plan) }),
      model: row.model,
      billsToUser: row.billsToUser,
    }));
  }

  /**
   * Reclaims a lease on behalf of a janitor that does not exist yet.
   *
   * Here so a worker's reaction to *losing* its lease can be provoked without reaching into the
   * rows: that reaction is the one thing standing between a paused worker and two writers on one
   * session, and a test of it must be able to say "and then the lease went away".
   */
  stealLease(requestId: string, newOwner: string): void {
    const row = this.#rows.find((candidate) => candidate.id === requestId);
    if (row === undefined) throw new Error(`no such turn request: ${requestId}`);
    row.leaseOwner = newOwner;
  }

  /**
   * Whether this row occupies its session, which is a question about **state alone**.
   *
   * An expired lease still holds the session, exactly as it does in Postgres — the partial unique
   * index is over `state = 'leased'` and knows nothing about the clock. Freeing a session on
   * expiry would let a second worker in while the first has not yet learned it is a zombie, which
   * is the two-writer failure the grace window exists to make unreachable. Only the janitor moves
   * a row out of `leased`, and only after that window.
   */
  #isLeased(row: Row): boolean {
    return row.state === "leased";
  }
}

function asSteer(row: SteerRow): Steer {
  return { id: row.id, text: row.text };
}

function asOrphan(row: Row): OrphanedTurnRequest {
  return { id: row.id, sessionId: row.sessionId, kind: row.kind, message: row.message };
}
