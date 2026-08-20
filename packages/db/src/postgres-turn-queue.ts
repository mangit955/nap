/**
 * The turn queue in Postgres — one in-flight request per session, cluster-wide.
 *
 * `SessionQueue` was a `Map` of promises in one process. It stopped a turn and a project-open both
 * creating a sandbox for the same project, and it stopped nothing at all once a second process
 * existed: each would create one, the project would end up holding two, and nobody could find or
 * stop paying for the second. Here the rule is a **partial unique index** over `state = 'leased'`,
 * which is the same posture the repo already takes with `unique(session_id, seq)`.
 *
 * **The claim is two statements inside one transaction, deliberately.** The design writes it as a
 * single `update … where id = (select … for update skip locked)`, which is correct but loses the
 * one thing the retry needs: when the unique index fires, that form has aborted the transaction
 * without ever telling the caller *which* candidate it was about to take, so "try the next one"
 * has nothing to exclude. Selecting the candidate first — still `for update skip locked`, so the
 * row is held for the transaction and no other worker can take it — makes the id known before the
 * update that may violate the index, and a retry can skip past it. The lock and the index behave
 * exactly as the one-statement form's do.
 *
 * A `not exists (… leased on this session …)` filter sits in the candidate query as well. It is
 * *not* what enforces the rule — it reads committed rows, so two workers racing still both see a
 * free session and one of them still gets `23505`. What it buys is that the ordinary case never
 * reaches the violation at all, so the retry path is for the race rather than for a full queue of
 * requests on one busy session.
 *
 * Everything else here is a single statement, and each is conditional on `lease_owner`. That is
 * the fencing: a worker can outlive its lease through a GC pause or a network blip, and without
 * the predicate it could renew or settle a request another worker had already claimed.
 */

import { LEASE_GRACE_MS, LEASE_TTL_MS, ORPHAN_SWEEP_LIMIT } from "@nap/shared/lease-windows";
import type {
  CancelOutcome,
  EnqueueTurnRequest,
  LeasedTurnRequest,
  LeaseRenewal,
  OrphanedTurnRequest,
  TurnQueue,
  TurnRequestSettlement,
} from "@nap/shared/ports/turn-queue";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { turnRequests } from "./schema.ts";

/**
 * How long a claim is good for, as a Postgres interval.
 *
 * The number lives in `@nap/shared/lease-windows` beside the renewal interval and the janitor's
 * grace, because the three have to agree and a constant in each file would drift.
 */
const LEASE_TTL = `${LEASE_TTL_MS} milliseconds`;

/**
 * How long past expiry a lease is left alone, as a Postgres interval.
 *
 * A fence rather than a timeout: renewal is conditional, so a worker that lost its lease has
 * aborted by expiry plus one renewal interval, and reclaiming only after this window is the sole
 * reason two writers on one session are unreachable. See `@nap/shared/lease-windows`.
 */
const LEASE_GRACE = `${LEASE_GRACE_MS} milliseconds`;

/**
 * How many candidates one `claim` will try before giving up for this tick.
 *
 * The retry is for losing a race, not for working through a backlog: each attempt that fails means
 * another worker claimed the same session in the microseconds since the candidate query read it,
 * and a worker that loses four of those in a row is better off returning empty-handed and coming
 * back than holding a connection open trying. Nothing is lost by giving up — the requests are
 * still queued, and the next tick sees them.
 */
const CLAIM_ATTEMPTS = 4;

/** Postgres's unique violation. Here it means another worker already holds the session. */
const UNIQUE_VIOLATION = "23505";

/** The partial unique index that *is* the one-in-flight-per-session rule. */
const ONE_LEASED_PER_SESSION = "turn_requests_one_leased_per_session";

/** What a lease occupies. Terminal states hold nothing and are excluded from every predicate. */
const IN_FLIGHT = ["queued", "leased"] as const;

export class PostgresTurnQueue implements TurnQueue {
  readonly #db: PostgresJsDatabase;

  /** Takes a database rather than a URL, for the reason `PostgresEventStore` does. */
  constructor(db: PostgresJsDatabase) {
    this.#db = db;
  }

  async enqueue(request: EnqueueTurnRequest): Promise<{ id: string }> {
    const [row] = await this.#db
      .insert(turnRequests)
      .values({
        sessionId: request.sessionId,
        userId: request.userId,
        kind: request.kind,
        message: request.message,
        model: request.model,
        billsToUser: request.billsToUser,
      })
      .returning({ id: turnRequests.id });

    // Postgres cannot return zero rows from a single-row insert; a missing row here would mean the
    // driver contract changed under us.
    if (row === undefined) throw new Error("insert into turn_requests returned no row");
    return { id: row.id };
  }

  async claim(owner: string): Promise<LeasedTurnRequest | null> {
    const tried: string[] = [];

    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const claimed = await this.#claimOnce(owner, tried);
      if (claimed.leased !== null) return claimed.leased;
      // Nothing left to try, as against having lost a race on one candidate.
      if (claimed.skip === null) return null;
      tried.push(claimed.skip);
    }

    return null;
  }

  /**
   * One attempt: hold the oldest claimable row, then lease it.
   *
   * Answers the leased request when it worked, and otherwise the id of a candidate that must be
   * skipped next time — either because another worker leased its session in the moment between the
   * two statements (the unique index firing, which is the mechanism working), or because the row
   * left `queued` while this transaction waited on its lock, which is a cancellation arriving in
   * the same instant.
   *
   * The candidate id is captured *outside* the transaction on purpose: a unique violation aborts
   * the transaction, so by the time the error is catchable there is nothing left inside it to ask.
   */
  async #claimOnce(
    owner: string,
    exclude: readonly string[],
  ): Promise<{ leased: LeasedTurnRequest | null; skip: string | null }> {
    let candidateId: string | null = null;

    try {
      const leased = await this.#db.transaction(async (tx) => {
        const [candidate] = await tx
          .select({ id: turnRequests.id })
          .from(turnRequests)
          .where(
            and(
              eq(turnRequests.state, "queued"),
              eq(turnRequests.cancelRequested, false),
              exclude.length === 0 ? undefined : notInArray(turnRequests.id, [...exclude]),
              // Reads committed rows, so it does not enforce anything — two workers racing both
              // see a free session and the index settles it. What it buys is that the ordinary
              // case never reaches the violation, so the retry above is for the race rather than
              // for a queue of requests piled up on one busy session.
              sql`not exists (
                select 1 from ${turnRequests} held
                where held.session_id = ${turnRequests.sessionId} and held.state = 'leased'
              )`,
            ),
          )
          .orderBy(turnRequests.createdAt)
          .limit(1)
          // Holds the row for this transaction, and steps over anything another worker is already
          // holding rather than queueing behind it.
          .for("update", { skipLocked: true });

        if (candidate === undefined) return null;
        candidateId = candidate.id;

        const [row] = await tx
          .update(turnRequests)
          .set({
            state: "leased",
            leaseOwner: owner,
            leaseExpiresAt: sql`now() + ${LEASE_TTL}::interval`,
            // Coalesced, so `started_at` is when a request first ran rather than when it last did.
            // Nothing requeues today, but the column should not quietly start lying if anything
            // ever does.
            startedAt: sql`coalesce(${turnRequests.startedAt}, now())`,
          })
          .where(and(eq(turnRequests.id, candidate.id), eq(turnRequests.state, "queued")))
          .returning();

        return row ?? null;
      });

      if (leased === null) return { leased: null, skip: candidateId };

      return {
        leased: {
          id: leased.id,
          sessionId: leased.sessionId,
          userId: leased.userId,
          kind: leased.kind,
          message: leased.message,
          model: leased.model,
          billsToUser: leased.billsToUser,
        },
        skip: null,
      };
    } catch (error) {
      // Somebody else leased this session between the candidate query and the update. Any other
      // failure is a real one and is rethrown — a unique violation from a different index would be
      // a bug, and swallowing it as "somebody beat me to it" would bury it.
      if (candidateId === null || !isSessionAlreadyLeased(error)) throw error;
      return { leased: null, skip: candidateId };
    }
  }

  async renew(requestId: string, owner: string): Promise<LeaseRenewal> {
    const [row] = await this.#db
      .update(turnRequests)
      .set({ leaseExpiresAt: sql`now() + ${LEASE_TTL}::interval` })
      // All three predicates matter. Without the owner, a worker whose lease was reclaimed would
      // renew its way back into one somebody else now holds; without the state, it would revive a
      // request the janitor had already closed out.
      .where(
        and(
          eq(turnRequests.id, requestId),
          eq(turnRequests.leaseOwner, owner),
          eq(turnRequests.state, "leased"),
        ),
      )
      // The same statement answers both questions a worker has every fifteen seconds.
      .returning({ cancelRequested: turnRequests.cancelRequested });

    if (row === undefined) return { held: false };
    return { held: true, cancelRequested: row.cancelRequested };
  }

  async settle(requestId: string, owner: string, state: TurnRequestSettlement): Promise<boolean> {
    const rows = await this.#db
      .update(turnRequests)
      .set({
        state,
        finishedAt: sql`now()`,
        // The lease is over, so the row must stop occupying the session — but `lease_owner` stays,
        // because who ran this request is worth being able to read afterwards and only `state`
        // decides whether the unique index applies.
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(turnRequests.id, requestId),
          eq(turnRequests.leaseOwner, owner),
          eq(turnRequests.state, "leased"),
        ),
      )
      .returning({ id: turnRequests.id });

    return rows.length > 0;
  }

  async requestCancel(sessionId: string): Promise<CancelOutcome> {
    const rows = await this.#db
      .update(turnRequests)
      .set({
        cancelRequested: true,
        // A queued request is failed here and now: it can never be claimed, and leaving it queued
        // and permanently skipped would be a request with no terminal state. A leased one is only
        // flagged — the worker owns its own abort, and it learns on its next renewal.
        state: sql`case when ${turnRequests.state} = 'queued' then 'failed' else ${turnRequests.state} end`,
        finishedAt: sql`case when ${turnRequests.state} = 'queued' then now() else ${turnRequests.finishedAt} end`,
      })
      // Both in-flight states in one statement, which is what makes this safe against a claim
      // committing underneath it: Postgres re-reads the row after the claim's lock is released,
      // finds it `leased` rather than `queued`, and flags it instead of missing it entirely.
      //
      // **Already-cancelled rows are deliberately still matched.** Filtering them out would make
      // a second click on a turn that is still running answer "there is nothing to cancel", which
      // is the opposite of what is true for the fifteen seconds before the worker's next renewal.
      // State is what ends a request, so re-flagging a leased one costs nothing.
      .where(
        and(eq(turnRequests.sessionId, sessionId), inArray(turnRequests.state, [...IN_FLIGHT])),
      )
      .returning({ state: turnRequests.state });

    // `failed` here can only be a row this statement just moved out of `queued`.
    if (rows.some((row) => row.state === "leased")) return { cancelled: true, was: "leased" };
    if (rows.length > 0) return { cancelled: true, was: "queued" };
    return { cancelled: false };
  }

  async orphanExpired(limit = ORPHAN_SWEEP_LIMIT): Promise<OrphanedTurnRequest[]> {
    return await this.#db
      .update(turnRequests)
      .set({ state: "orphaned" })
      // `for update skip locked` is what makes two janitors ticking at once safe: whichever holds
      // the row takes it, and the other steps over it rather than waiting to update a row that is
      // about to stop being `leased`. Ordered by expiry, so the longest-abandoned turn — the one
      // whose chat pane has been spinning longest — is closed out first.
      .where(
        sql`${turnRequests.id} in (
          select id from ${turnRequests}
          where state = 'leased'
            and lease_expires_at < now() - ${LEASE_GRACE}::interval
          order by lease_expires_at
          for update skip locked
          limit ${limit}
        )`,
      )
      // `finished_at` is deliberately left null, and `lease_expires_at` deliberately left set. The
      // first is the marker saying this request's terminal events are not in the log yet; the
      // second is the only record of when its worker went silent, and no index reads it outside
      // `state = 'leased'`.
      .returning({
        id: turnRequests.id,
        sessionId: turnRequests.sessionId,
        kind: turnRequests.kind,
      });
  }

  async unannouncedOrphans(limit = ORPHAN_SWEEP_LIMIT): Promise<OrphanedTurnRequest[]> {
    return await this.#db
      .select({
        id: turnRequests.id,
        sessionId: turnRequests.sessionId,
        kind: turnRequests.kind,
      })
      .from(turnRequests)
      .where(and(eq(turnRequests.state, "orphaned"), isNull(turnRequests.finishedAt)))
      .orderBy(asc(turnRequests.leaseExpiresAt))
      .limit(limit);
  }

  async markOrphanAnnounced(requestId: string): Promise<void> {
    await this.#db
      .update(turnRequests)
      .set({ finishedAt: sql`now()` })
      // Conditional on the state, so this can never be mistaken for a settlement: only the
      // janitor's own rows are terminal with a null `finished_at`.
      .where(and(eq(turnRequests.id, requestId), eq(turnRequests.state, "orphaned")));
  }
}

/**
 * Whether this failure is the partial unique index saying another worker holds the session.
 *
 * Drizzle wraps whatever the driver raised in a `Failed query: …` error and puts the original on
 * `.cause`, so the chain is walked rather than the top-level error read — the same shape
 * `isTransientAppendFailure` deals with. The **constraint name is checked as well as the
 * SQLSTATE**, so a unique violation from any other index stays an error rather than being
 * mistaken for a lost race and quietly retried.
 */
function isSessionAlreadyLeased(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (typeof current !== "object") return false;

    const { code, constraint_name: constraint } = current as {
      code?: unknown;
      constraint_name?: unknown;
    };
    if (code === UNIQUE_VIOLATION && constraint === ONE_LEASED_PER_SESSION) return true;

    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
