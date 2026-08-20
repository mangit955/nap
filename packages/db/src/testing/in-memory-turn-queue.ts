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
import type {
  CancelOutcome,
  EnqueueTurnRequest,
  LeasedTurnRequest,
  LeaseRenewal,
  OrphanedTurnRequest,
  TurnQueue,
  TurnRequestKind,
  TurnRequestSettlement,
  TurnRequestState,
} from "@nap/shared/ports/turn-queue";

type Row = {
  id: string;
  sessionId: string;
  userId: string;
  kind: TurnRequestKind;
  message: string | null;
  model: string;
  billsToUser: boolean;
  state: TurnRequestState;
  cancelRequested: boolean;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  /** When this row's terminal events reached the log. Null on an orphan nobody has announced. */
  finishedAt: number | null;
};

export type InMemoryTurnQueueOptions = {
  /** Milliseconds since the epoch. Defaults to the real clock. */
  now?: () => number;
  /** How long a claim is good for. Defaults to the shared lease TTL. */
  leaseTtlMs?: number;
  /** How long past expiry the janitor waits. Defaults to the shared grace. */
  leaseGraceMs?: number;
};

export class InMemoryTurnQueue implements TurnQueue {
  readonly #rows: Row[] = [];
  readonly #now: () => number;
  readonly #leaseTtlMs: number;
  readonly #leaseGraceMs: number;
  #sequence = 0;

  constructor(options: InMemoryTurnQueueOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#leaseTtlMs = options.leaseTtlMs ?? LEASE_TTL_MS;
    this.#leaseGraceMs = options.leaseGraceMs ?? LEASE_GRACE_MS;
  }

  async enqueue(request: EnqueueTurnRequest): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    this.#sequence += 1;
    this.#rows.push({
      id,
      sessionId: request.sessionId,
      userId: request.userId,
      kind: request.kind,
      message: request.message,
      model: request.model,
      billsToUser: request.billsToUser,
      state: "queued",
      cancelRequested: false,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: null,
      // The sequence, not the clock: two requests enqueued in the same millisecond still have an
      // order, and a test that injected a frozen clock would otherwise have none.
      createdAt: this.#sequence,
    });
    return { id };
  }

  async claim(owner: string): Promise<LeasedTurnRequest | null> {
    const held = new Set(
      this.#rows.filter((row) => this.#isLeased(row)).map((row) => row.sessionId),
    );

    const candidate = this.#rows
      .filter((row) => row.state === "queued" && !row.cancelRequested && !held.has(row.sessionId))
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (candidate === undefined) return null;

    candidate.state = "leased";
    candidate.leaseOwner = owner;
    candidate.leaseExpiresAt = this.#now() + this.#leaseTtlMs;

    return {
      id: candidate.id,
      sessionId: candidate.sessionId,
      userId: candidate.userId,
      kind: candidate.kind,
      message: candidate.message,
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

  async requestCancel(sessionId: string): Promise<CancelOutcome> {
    // Already-cancelled rows still match, as they do in Postgres: a second click on a turn that
    // is still running must not be told there is nothing to cancel.
    const rows = this.#rows.filter(
      (row) => row.sessionId === sessionId && (row.state === "queued" || row.state === "leased"),
    );
    if (rows.length === 0) return { cancelled: false };

    let was: "queued" | "leased" = "queued";
    for (const row of rows) {
      row.cancelRequested = true;
      if (row.state === "leased") was = "leased";
      else {
        row.state = "failed";
        row.finishedAt = this.#now();
      }
    }
    return { cancelled: true, was };
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

  /** What state a request is in, for tests that assert on the queue rather than through it. */
  stateOf(requestId: string): TurnRequestState | null {
    return this.#rows.find((row) => row.id === requestId)?.state ?? null;
  }

  /**
   * Everything ever enqueued, oldest first.
   *
   * What an admission test asserts on: the route's whole job is now to write one of these down
   * correctly — the right prompt, the model it resolved, and *whether* the asker pays.
   */
  get enqueued(): readonly EnqueueTurnRequest[] {
    return this.#rows.map((row) => ({
      sessionId: row.sessionId,
      userId: row.userId,
      kind: row.kind,
      message: row.message,
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

function asOrphan(row: Row): OrphanedTurnRequest {
  return { id: row.id, sessionId: row.sessionId, kind: row.kind };
}
