import { PlanIntentSchema } from "@nap/shared/agent-plan";
import { MediaAttachmentsSchema } from "@nap/shared/media";
/**
 * The turn queue in Postgres — one in-flight request per session, cluster-wide.
 *
 * `SessionQueue` was a `Map` of promises in one process. It stopped a turn and a project-open both
 * creating a sandbox for the same project, and it stopped nothing at all once a second process
 * existed: each would create one, the project would end up holding two, and nobody could find or
 * stop paying for the second. Here the rule is a **partial unique index** over `state = 'leased'`,
 * which is the same posture the repo already takes with `unique(session_id, seq)`.
 *
 * **Candidate selection and grant are separate statements in one transaction.** The design uses a
 * single `update … where id = (select … for update skip locked)`, which is correct but loses the
 * one thing the retry needs: when the unique index fires, that form has aborted the transaction
 * without ever telling the caller *which* candidate it was about to take, so "try the next one"
 * has nothing to exclude. Selecting the candidate first — still `for update skip locked`, so the
 * row is held for the transaction and no other worker can take it — makes the id known before the
 * update that may violate the index, and a retry can skip past it. The lock and the index behave
 * exactly as the one-statement form's do.
 *
 * After selecting a request, claim separately locks its project row, shared with owner computer
 * input, then grants the lease and changes the project's input revision in the same transaction.
 * The project lock ends at commit, before any turn execution begins.
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
  TurnRequestStatus,
} from "@nap/shared/ports/turn-queue";
import { and, asc, count, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  projectComputerOperations,
  projects,
  sessions,
  turnRequests,
  turnSteers,
} from "./schema.ts";

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

/**
 * The primary keys a steer's id can collide on: its own row, or the turn request it fell back to.
 * Two retries of one message racing is the only ordinary way to reach either.
 */
const SUBMISSION_KEYS = new Set(["turn_steers_pkey", "turn_requests_pkey"]);

/** What a lease occupies. Terminal states hold nothing and are excluded from every predicate. */
const IN_FLIGHT = ["queued", "leased"] as const;

export class PostgresTurnQueue implements TurnQueue, SteerQueue {
  readonly #db: PostgresJsDatabase;

  /** Takes a database rather than a URL, for the reason `PostgresEventStore` does. */
  constructor(db: PostgresJsDatabase) {
    this.#db = db;
  }

  async enqueue(request: EnqueueTurnRequest): Promise<void> {
    await this.#db.insert(turnRequests).values({
      // The caller's, not the column's — `turn_requests.id` carries no default, so that the
      // Turn's identity exists before the row and therefore before any execution of it.
      id: request.id,
      sessionId: request.sessionId,
      userId: request.userId,
      kind: request.kind,
      message: request.message,
      attachments: request.attachments ?? null,
      plan: request.plan ?? null,
      model: request.model,
      billsToUser: request.billsToUser,
    });
  }

  async getStatus(request: {
    id: string;
    sessionId: string;
    userId: string;
  }): Promise<TurnRequestStatus | null> {
    const [row] = await this.#db
      .select({ id: turnRequests.id, state: turnRequests.state })
      .from(turnRequests)
      .where(
        and(
          eq(turnRequests.id, request.id),
          eq(turnRequests.sessionId, request.sessionId),
          eq(turnRequests.userId, request.userId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async hasPending(sessionId: string): Promise<boolean> {
    const [row] = await this.#db
      .select({ id: turnRequests.id })
      .from(turnRequests)
      .where(
        and(
          eq(turnRequests.sessionId, sessionId),
          inArray(turnRequests.state, ["queued", "leased"]),
        ),
      )
      .limit(1);
    return row !== undefined;
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
        const skippedProjects: string[] = [];
        for (;;) {
          const [candidate] = await tx
            .select({ id: turnRequests.id, projectId: sessions.projectId })
            .from(turnRequests)
            .innerJoin(sessions, eq(sessions.id, turnRequests.sessionId))
            .where(
              and(
                eq(turnRequests.state, "queued"),
                eq(turnRequests.cancelRequested, false),
                exclude.length === 0 ? undefined : notInArray(turnRequests.id, [...exclude]),
                skippedProjects.length === 0
                  ? undefined
                  : notInArray(sessions.projectId, skippedProjects),
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
            // Lock only the request here. The separate project lookup below avoids taking
            // project locks for candidates that the request scan skips.
            .for("update", { of: turnRequests, skipLocked: true });

          if (candidate === undefined) return null;
          const [project] = await tx
            .select({ id: projects.id })
            .from(projects)
            .where(eq(projects.id, candidate.projectId))
            .for("update", { skipLocked: true });
          if (project === undefined) {
            // Skip all sessions of this project, without spending the session-race retry budget.
            // These request locks last only until this short claim transaction ends.
            skippedProjects.push(candidate.projectId);
            continue;
          }
          const [input] = await tx
            .select({ id: projectComputerOperations.projectId })
            .from(projectComputerOperations)
            .where(eq(projectComputerOperations.projectId, candidate.projectId))
            .limit(1);
          if (input !== undefined) {
            skippedProjects.push(candidate.projectId);
            continue;
          }
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

          if (row === undefined) return null;
          // Atomic with the grant, and changed only when the grant succeeded. A claim followed by
          // completion must still invalidate any input grant issued before it began.
          await tx
            .update(projects)
            .set({ computerRevision: sql`gen_random_uuid()` })
            .where(eq(projects.id, candidate.projectId));
          return row;
        }
      });

      if (leased === null) return { leased: null, skip: candidateId };

      return {
        leased: {
          id: leased.id,
          sessionId: leased.sessionId,
          userId: leased.userId,
          kind: leased.kind,
          message: leased.message,
          ...(leased.attachments === null
            ? {}
            : { attachments: MediaAttachmentsSchema.parse(leased.attachments) }),
          ...(leased.plan === null ? {} : { plan: PlanIntentSchema.parse(leased.plan) }),
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

  async anyLeased(sessionIds: readonly string[]): Promise<boolean> {
    // No sessions is not busy, and asking anyway would send an empty array into a `= any` for no
    // reason. A project with nothing under it cannot have a turn running in it.
    if (sessionIds.length === 0) return false;

    const [row] = await this.#db
      .select({ id: turnRequests.id })
      .from(turnRequests)
      // `state = 'leased'` and nothing about the clock, exactly as the partial unique index is: a
      // lease past its expiry still occupies its session until the janitor closes it out, and a
      // worker that has not yet learned it is a zombie may still be writing.
      .where(
        and(inArray(turnRequests.sessionId, [...sessionIds]), eq(turnRequests.state, "leased")),
      )
      .limit(1);

    return row !== undefined;
  }

  async requestCancel(sessionId: string): Promise<CancelOutcome> {
    const rows = await this.#db
      .update(turnRequests)
      .set({
        cancelRequested: true,
        // A queued request is failed here and now: it can never be claimed, and leaving it queued
        // and permanently skipped would be a request with no terminal state. A leased one is only
        // flagged — the worker owns its own abort, and reads this flag when it next renews.
        state: sql`case when ${turnRequests.state} = 'queued' then 'failed' else ${turnRequests.state} end`,
        finishedAt: sql`case when ${turnRequests.state} = 'queued' then now() else ${turnRequests.finishedAt} end`,
      })
      // Both in-flight states in one statement, which is what makes this safe against a claim
      // committing underneath it: Postgres re-reads the row after the claim's lock is released,
      // finds it `leased` rather than `queued`, and flags it instead of missing it entirely.
      //
      // **Already-cancelled rows are deliberately still matched.** Filtering them out would make
      // a second click on a turn that is still running answer "there is nothing to cancel", which
      // is the opposite of what is true until the worker has actually stopped. State is what ends
      // a request, so re-flagging a leased one costs nothing.
      .where(
        and(eq(turnRequests.sessionId, sessionId), inArray(turnRequests.state, [...IN_FLIGHT])),
      )
      .returning({ id: turnRequests.id, state: turnRequests.state });

    // At most one, by the partial unique index. `failed` here can only be a row this statement just
    // moved out of `queued`.
    const leased = rows.find((row) => row.state === "leased");
    if (leased !== undefined) return { cancelled: true, was: "leased", requestId: leased.id };
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
      //
      // `= any(array(…))` rather than `in (…)` so the limit holds whatever plan Postgres picks.
      // `in` may be planned as a nested-loop semi-join that re-runs the locking subquery once per
      // outer row; each re-run skips the rows this statement has already updated, so its `limit`
      // hands back later ones and the update takes more than `limit`. An uncorrelated `array(…)`
      // is evaluated once, before the update reads anything.
      .where(
        sql`${turnRequests.id} = any(array(
          select id from ${turnRequests}
          where state = 'leased'
            and lease_expires_at < now() - ${LEASE_GRACE}::interval
          order by lease_expires_at, id
          for update skip locked
          limit ${limit}
        ))`,
      )
      // `finished_at` is deliberately left null, and `lease_expires_at` deliberately left set. The
      // first is the marker saying this request's terminal events are not in the log yet; the
      // second is the only record of when its worker went silent, and no index reads it outside
      // `state = 'leased'`.
      .returning({
        id: turnRequests.id,
        sessionId: turnRequests.sessionId,
        kind: turnRequests.kind,
        message: turnRequests.message,
      });
  }

  async unannouncedOrphans(limit = ORPHAN_SWEEP_LIMIT): Promise<OrphanedTurnRequest[]> {
    return await this.#db
      .select({
        id: turnRequests.id,
        sessionId: turnRequests.sessionId,
        kind: turnRequests.kind,
        message: turnRequests.message,
      })
      .from(turnRequests)
      .where(and(eq(turnRequests.state, "orphaned"), isNull(turnRequests.finishedAt)))
      .orderBy(asc(turnRequests.leaseExpiresAt))
      .limit(limit);
  }

  /**
   * Admission, as one transaction that holds the leased request's row while it decides.
   *
   * The lock is the fence (ADR-0027). `close` updates the same row, and the two conflict, so either
   * this commits first and `close` resolves the steer it inserted, or `close` commits first and this
   * re-reads the row — Postgres re-checks a locked row's predicate once the lock is released — finds
   * it closed, and queues a turn instead. `no key update` rather than `share` because it also
   * serializes two admissions with each other, which is what keeps the backlog count honest; a
   * renewal waits behind one for the length of an insert.
   */
  async steer(request: SteerRequest): Promise<SteerAdmission> {
    const earlier = await this.find(request);
    if (earlier !== null) return earlier;

    try {
      return await this.#db.transaction(async (tx) => {
        const planning = request.plan?.intent === "propose";
        const [target] = await tx
          .select({ id: turnRequests.id })
          .from(turnRequests)
          .where(
            and(
              eq(turnRequests.sessionId, request.sessionId),
              eq(turnRequests.state, "leased"),
              eq(turnRequests.kind, "turn"),
              sql`btrim(coalesce(${turnRequests.message}, '')) <> '/compact'`,
              eq(turnRequests.cancelRequested, false),
              eq(turnRequests.steeringClosed, false),
              // A planning turn takes planning messages, and a building turn the rest.
              planning
                ? sql`${turnRequests.plan}->>'intent' = 'propose'`
                : sql`coalesce(${turnRequests.plan}->>'intent', '') <> 'propose'`,
            ),
          )
          .for("no key update");

        // Again, now that the row is held. The `find` above ran before any lock, so a retry of
        // this message that committed while this one waited is invisible to it — and if the
        // other attempt joined and filled the backlog, or joined just before the request closed,
        // this one would otherwise queue the same words again as a turn under the same id, in a
        // table where nothing collides with the steer. Each statement reads what has committed by
        // the time it starts, so this sees whatever the attempt ahead of it on the row did.
        const already = await findIn(tx, request);
        if (already !== null) return already;

        if (target !== undefined) {
          const [waiting] = await tx
            .select({ n: count() })
            .from(turnSteers)
            .where(and(eq(turnSteers.requestId, target.id), eq(turnSteers.state, "pending")));
          if ((waiting?.n ?? 0) < MAX_WAITING_STEERS) {
            await tx.insert(turnSteers).values({
              id: request.id,
              sessionId: request.sessionId,
              userId: request.userId,
              requestId: target.id,
              message: request.message,
              plan: request.plan ?? null,
              model: request.model,
              billsToUser: request.billsToUser,
            });
            return { as: "steer", requestId: target.id } as const;
          }
        }

        await tx.insert(turnRequests).values({
          id: request.id,
          sessionId: request.sessionId,
          userId: request.userId,
          kind: "turn",
          message: request.message,
          plan: request.plan ?? null,
          model: request.model,
          billsToUser: request.billsToUser,
        });
        return { as: "turn" } as const;
      });
    } catch (error) {
      // A retry of the same message committed first. Whatever it did is the answer.
      if (!isSubmissionTaken(error)) throw error;
      const found = await this.find(request);
      if (found === null) throw error;
      return found;
    }
  }

  async find(
    request: Pick<SteerRequest, "id" | "sessionId" | "userId">,
  ): Promise<SteerAdmission | null> {
    return await findIn(this.#db, request);
  }

  async take(requestId: string, owner: string): Promise<Steer[]> {
    const rows = await this.#db
      .update(turnSteers)
      .set({ state: "applied", resolvedAt: sql`now()` })
      .where(
        and(
          eq(turnSteers.requestId, requestId),
          eq(turnSteers.state, "pending"),
          // The fencing renewal uses: a worker that lost its lease reads nobody's words.
          sql`exists (
            select 1 from ${turnRequests}
            where ${turnRequests.id} = ${requestId}
              and ${turnRequests.leaseOwner} = ${owner}
              and ${turnRequests.state} = 'leased'
              -- A request being stopped reads nothing more: what waits is the person's to have
              -- back, and admission already refuses it for the same reason.
              and ${turnRequests.cancelRequested} = false
          )`,
        ),
      )
      .returning({ id: turnSteers.id, text: turnSteers.message, createdAt: turnSteers.createdAt });
    return oldestFirst(rows).map(({ id, text }) => ({ id, text }));
  }

  async close(
    requestId: string,
    owner: string,
    disposition: "defer" | "drop",
  ): Promise<ClosedSteers> {
    return await this.#db.transaction(async (tx) => {
      // The other half of the fence: this update conflicts with admission's lock, so no steer can
      // join between it and the resolution below.
      const [held] = await tx
        .update(turnRequests)
        .set({ steeringClosed: true })
        .where(
          and(
            eq(turnRequests.id, requestId),
            eq(turnRequests.leaseOwner, owner),
            eq(turnRequests.state, "leased"),
            eq(turnRequests.steeringClosed, false),
          ),
        )
        .returning({ id: turnRequests.id, cancelRequested: turnRequests.cancelRequested });
      if (held === undefined) return { deferred: [], dropped: [] };
      // A Stop is in this row before the worker hears of it, which can be a renewal later. Read
      // here, under the lock, rather than trusted from the caller: deferring would queue the
      // person's words as turns the Stop never saw, and those would run.
      const resolution = held.cancelRequested ? "drop" : disposition;

      const waiting = oldestFirst(
        await tx
          .update(turnSteers)
          .set({ state: resolution === "defer" ? "deferred" : "dropped", resolvedAt: sql`now()` })
          .where(and(eq(turnSteers.requestId, requestId), eq(turnSteers.state, "pending")))
          .returning(),
      );
      if (resolution === "drop" || waiting.length === 0)
        return {
          deferred: [],
          dropped: waiting.map(({ id, message }) => ({ id, text: message })),
        };

      // Each becomes the turn it would have been had nothing been running: same id, same words,
      // same model and payer, queued in the order it was sent.
      await tx
        .insert(turnRequests)
        .values(
          waiting.map((steer) => ({
            id: steer.id,
            sessionId: steer.sessionId,
            userId: steer.userId,
            kind: "turn" as const,
            message: steer.message,
            plan: steer.plan,
            model: steer.model,
            billsToUser: steer.billsToUser,
            createdAt: steer.createdAt,
          })),
        )
        // Admission never lets one message be both a steer and a turn, but one stray row must not
        // be able to fail the whole close and leave every steer here waiting for nothing. A turn
        // request already under this id is this message, already queued as a turn: deferred is
        // what it is, and inserting it again would run the same words twice.
        .onConflictDoNothing({ target: turnRequests.id });
      return { deferred: waiting.map(({ id, message }) => ({ id, text: message })), dropped: [] };
    });
  }

  async steersOf(requestId: string): Promise<(Steer & { state: SteerState })[]> {
    return await this.#db
      .select({ id: turnSteers.id, text: turnSteers.message, state: turnSteers.state })
      .from(turnSteers)
      .where(eq(turnSteers.requestId, requestId))
      .orderBy(asc(turnSteers.createdAt));
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
 * Where an id already landed, read through `db` — the pool, or an admission's own transaction so
 * the answer reflects what committed while it waited on the request's row.
 */
async function findIn(
  db: Pick<PostgresJsDatabase, "select">,
  request: Pick<SteerRequest, "id" | "sessionId" | "userId">,
): Promise<SteerAdmission | null> {
  const [steer] = await db
    .select({
      sessionId: turnSteers.sessionId,
      userId: turnSteers.userId,
      requestId: turnSteers.requestId,
    })
    .from(turnSteers)
    .where(eq(turnSteers.id, request.id));
  // Checked first: a deferred steer has a turn request under the same id as well, and what the
  // first attempt did was join.
  if (steer !== undefined)
    return steer.sessionId === request.sessionId && steer.userId === request.userId
      ? { as: "steer", requestId: steer.requestId }
      : { as: "conflict" };

  const [turn] = await db
    .select({ sessionId: turnRequests.sessionId, userId: turnRequests.userId })
    .from(turnRequests)
    .where(eq(turnRequests.id, request.id));
  if (turn === undefined) return null;
  return turn.sessionId === request.sessionId && turn.userId === request.userId
    ? { as: "turn" }
    : { as: "conflict" };
}

/** `returning` carries no order, and the order a person sent their messages in is the point. */
function oldestFirst<T extends { createdAt: Date }>(rows: T[]): T[] {
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Whether this failure is a message's id already being taken, by a retry of the same message. */
function isSubmissionTaken(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (typeof current !== "object") return false;
    const { code, constraint_name: constraint } = current as {
      code?: unknown;
      constraint_name?: unknown;
    };
    if (code === UNIQUE_VIOLATION && typeof constraint === "string")
      return SUBMISSION_KEYS.has(constraint);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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
