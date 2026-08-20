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

import { LEASE_TTL_MS } from "@nap/shared/lease-windows";
import type {
  CancelOutcome,
  EnqueueTurnRequest,
  LeasedTurnRequest,
  LeaseRenewal,
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
};

export type InMemoryTurnQueueOptions = {
  /** Milliseconds since the epoch. Defaults to the real clock. */
  now?: () => number;
  /** How long a claim is good for. Defaults to the shared lease TTL. */
  leaseTtlMs?: number;
};

export class InMemoryTurnQueue implements TurnQueue {
  readonly #rows: Row[] = [];
  readonly #now: () => number;
  readonly #leaseTtlMs: number;
  #sequence = 0;

  constructor(options: InMemoryTurnQueueOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#leaseTtlMs = options.leaseTtlMs ?? LEASE_TTL_MS;
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
      else row.state = "failed";
    }
    return { cancelled: true, was };
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

  /** An expired lease is not a held one, whoever still thinks they own it. */
  #isLeased(row: Row): boolean {
    return row.state === "leased" && (row.leaseExpiresAt ?? 0) > this.#now();
  }
}
