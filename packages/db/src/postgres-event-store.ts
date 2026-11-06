/**
 * The durable event log, backed by Postgres.
 *
 * `seq` is the whole difficulty. Replay and dedupe both key off it, so it has to be gapless
 * and monotonic per session even when several turns — or several processes — append at once.
 *
 * **An append is one statement.** It increments the session's `head_seq` and inserts the event
 * at the new value, in a data-modifying CTE that commits on its own. The row lock the increment
 * takes is the per-session serialization: a second writer blocks on it, and once the first
 * commits it re-reads the row and gets the next value. That is cluster-wide, as the advisory lock
 * this replaced was, and it is one round trip where the lock was four — `BEGIN`, the lock, the
 * insert, `COMMIT`. The sink appends a turn's events strictly in order, so every round trip here
 * is a delay on every token and tool call the person is watching stream in.
 *
 * An advisory lock cannot be taken inside the same single statement, and the reason is worth
 * knowing before anyone tries: the statement's snapshot is taken before the lock is granted, so
 * a `max(seq)` read through it after waiting does not see the writer it waited for, and the two
 * collide. A row lock does not have that problem, because an `UPDATE` that waits re-evaluates the
 * row it waited on.
 *
 * **`max(seq)` still takes part, as a floor.** A row can reach the table without advancing the
 * counter — the previous release's append during a rolling deploy, or a fixture inserting rows
 * directly — and a counter left behind the log would hand out a `seq` that already exists, on
 * every append, for the rest of that session's life. Taking the greater of the two catches up
 * instead. It is one backward step on the `(session_id, seq)` index, and it is never the
 * serialization: concurrent writers that both skipped the counter can still collide, which is
 * what `unique(session_id, seq)` is there to refuse — the database's backstop, never expected to
 * fire.
 *
 * A retried append is the one that stays a transaction, because it has a question to answer
 * before it writes. A caller whose first attempt failed without a knowable outcome passes
 * `retryAfterSeq`, and the store then locks the same counter row, which waits out the interrupted
 * attempt if it is somehow still in flight, and only then looks for the event above that
 * watermark. Looking without the lock would race the very writer being asked about. Retries are
 * rare, so the extra round trips there cost nothing that matters.
 *
 * Both methods read `created_at` back from the row rather than echoing what the caller
 * passed. The column is `timestamptz` and the contract is an ISO-8601 string, so the value
 * is normalized on the way through; taking it from the row in both places is what makes a
 * replayed event byte-identical to the one that was published live.
 *
 * Rows are parsed against the event union on the way out. A row that does not parse is
 * corruption rather than an expected failure, so it throws.
 */

import { isSameEvent } from "@nap/shared/event-identity";
import { type NapEvent, NapEventSchema } from "@nap/shared/events";
import type {
  AppendOptions,
  EventStore,
  PendingEvent,
  StoredEvent,
} from "@nap/shared/ports/event-store";
import { and, asc, eq, gt, max, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { EventTailReader, SessionCursors } from "./event-tail-reader.ts";
import { events, sessions } from "./schema.ts";

/** The shape `select().from(events)` and `.returning()` both produce. */
type EventRow = typeof events.$inferSelect;

function toEvent(row: EventRow): StoredEvent {
  return NapEventSchema.parse({
    type: row.type,
    sessionId: row.sessionId,
    turnId: row.turnId,
    seq: row.seq,
    createdAt: row.createdAt.toISOString(),
    payload: row.payload,
  } satisfies Record<keyof NapEvent, unknown>);
}

/**
 * The event as the column would hold it.
 *
 * `created_at` is `timestamptz`, so a row read back is never string-identical to what the
 * caller passed — `…T12:00:00Z` returns as `…T12:00:00.000Z`. Comparing the two raw would find
 * no match for an event that is plainly there, and the retry would write it twice.
 */
function normalized(event: PendingEvent): PendingEvent {
  return { ...event, createdAt: new Date(event.createdAt).toISOString() };
}

/** The database itself, or a transaction on it — the one append has to run in either. */
type Writer = PostgresJsDatabase | Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

/**
 * Advances the session's counter and inserts the event at it, in one statement.
 *
 * The only place a row is added to `events`, which is what lets the counter be trusted. See the
 * module comment for why the counter's row lock is the serialization and `max(seq)` the floor.
 */
async function insertNext(db: Writer, event: PendingEvent): Promise<EventRow> {
  const next = db.$with("next").as(
    db
      .update(sessions)
      .set({
        headSeq: sql`greatest(${sessions.headSeq}, (select coalesce(max(${events.seq}), 0) from ${events} where ${events.sessionId} = ${event.sessionId}::uuid)) + 1`,
      })
      .where(eq(sessions.id, event.sessionId))
      .returning({ headSeq: sessions.headSeq }),
  );

  const [inserted] = await db
    .with(next)
    .insert(events)
    .values({
      sessionId: event.sessionId,
      turnId: event.turnId,
      // A session that does not exist updates no row, and `next` is empty. Zero rather than
      // null, so the insert still fails on the foreign key — 23503, which the sink knows is not
      // worth retrying — instead of on a not-null constraint nobody would recognise.
      seq: sql`coalesce((select head_seq from next), 0)`,
      type: event.type,
      payload: event.payload,
      createdAt: new Date(event.createdAt),
    })
    .returning();

  // Postgres has no way to return zero rows from a single-row insert that succeeded; a missing
  // row here would mean the driver contract changed under us.
  if (inserted === undefined) throw new Error("insert into events returned no row");
  return inserted;
}

export class PostgresEventStore implements EventStore, EventTailReader {
  readonly #db: PostgresJsDatabase;

  /**
   * Takes a database rather than a connection string: the store does not own the pool, and
   * a test can hand it the same connection it seeds its rows with.
   */
  constructor(db: PostgresJsDatabase) {
    this.#db = db;
  }

  async append(event: PendingEvent, options: AppendOptions = {}): Promise<StoredEvent> {
    if (options.retryAfterSeq === undefined) return toEvent(await insertNext(this.#db, event));

    const { retryAfterSeq } = options;
    const row = await this.#db.transaction(async (tx) => {
      // The lock every append takes, held to the end of this transaction. An interrupted
      // attempt still in flight holds it until it commits or aborts, so once this returns the
      // log is settled and the question below has an answer.
      await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, event.sessionId))
        .for("no key update");

      // A retry may be following an attempt that committed and then lost its acknowledgement,
      // which is indistinguishable from one that never committed. Is this event already above
      // the caller's watermark? Rows at or below it were durable before the attempt began and
      // cannot be it, which is what stops an identical earlier event from being mistaken for
      // this one.
      //
      // The scan is bounded by how far the log moved since the caller last heard from it —
      // normally nothing, since a session's appends are serialized.
      const since = await tx
        .select()
        .from(events)
        .where(and(eq(events.sessionId, event.sessionId), gt(events.seq, retryAfterSeq)))
        .orderBy(asc(events.seq));

      const already = since.find((candidate) => isSameEvent(normalized(event), toEvent(candidate)));
      return already ?? (await insertNext(tx, event));
    });

    return toEvent(row);
  }

  async readFrom(sessionId: string, afterSeq: number): Promise<StoredEvent[]> {
    const rows = await this.#db
      .select()
      .from(events)
      .where(and(eq(events.sessionId, sessionId), gt(events.seq, afterSeq)))
      .orderBy(asc(events.seq));

    return rows.map(toEvent);
  }

  async headSeq(sessionId: string): Promise<number> {
    const [row] = await this.#db
      .select({ head: max(events.seq) })
      .from(events)
      .where(eq(events.sessionId, sessionId));

    // `max` over no rows is SQL NULL, and a session with no events has a log ending at 0 —
    // which is exactly the cursor a subscriber to a brand-new session should start from.
    return row?.head ?? 0;
  }

  async readTails(cursors: SessionCursors): Promise<StoredEvent[]> {
    // Not merely an optimisation: `or()` over nothing is `undefined`, which drizzle reads as
    // "no filter" — an empty map would otherwise read every event in the table.
    if (cursors.size === 0) return [];

    const perSession = [...cursors].map(([sessionId, afterSeq]) =>
      and(eq(events.sessionId, sessionId), gt(events.seq, afterSeq)),
    );

    // One query rather than one per session. At a hundred live sessions the alternative is a
    // hundred round trips every poll interval, against a database that is also serving turns.
    // Each branch is an index seek on `unique(session_id, seq)`, so the disjunction stays cheap.
    const rows = await this.#db
      .select()
      .from(events)
      .where(or(...perSession))
      .orderBy(asc(events.sessionId), asc(events.seq));

    return rows.map(toEvent);
  }
}
