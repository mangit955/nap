/**
 * The durable event log, backed by Postgres.
 *
 * `seq` is the whole difficulty. Replay and dedupe both key off it, so it has to be gapless
 * and monotonic per session even when several turns — or several API processes — append at
 * once. This takes a per-session advisory lock for the duration of the inserting
 * transaction and derives the next value inside the same statement. The alternatives were
 * both worse: `max(seq) + 1` with no lock races under read-committed, so a hundred parallel
 * writers collide and the code spends its time retrying unique violations; and a counter
 * held in the process is wrong the moment a second instance exists, while an advisory lock
 * is cluster-wide. `unique(session_id, seq)` remains the database's backstop — it is simply
 * never expected to fire.
 *
 * The lock earns its keep a second time for a retried append. A caller whose first attempt
 * failed without a knowable outcome sets `isRetry`, and the store then decides *under the same
 * lock* whether that attempt committed, by comparing the session's newest row against the event
 * it was handed. Doing it outside the lock would race the very writer being asked about.
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
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { events } from "./schema.ts";

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

export class PostgresEventStore implements EventStore {
  readonly #db: PostgresJsDatabase;

  /**
   * Takes a database rather than a connection string: the store does not own the pool, and
   * a test can hand it the same connection it seeds its rows with.
   */
  constructor(db: PostgresJsDatabase) {
    this.#db = db;
  }

  async append(event: PendingEvent, options: AppendOptions = {}): Promise<StoredEvent> {
    const row = await this.#db.transaction(async (tx) => {
      // Held until the transaction ends, so the read of max(seq) below and the insert that
      // depends on it cannot be interleaved with another writer's.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${event.sessionId}))`);

      // A retry may be following an attempt that committed and then lost its acknowledgement,
      // which is indistinguishable from one that never committed. Under the same lock the
      // newest row is settled, and the newest row is the only one the interrupted attempt can
      // have written — a session's appends are serialized, both by the sink's own chain and by
      // there being one leased request per session — so if it is this event, the append
      // already happened.
      if (options.isRetry === true) {
        const [newest] = await tx
          .select()
          .from(events)
          .where(eq(events.sessionId, event.sessionId))
          .orderBy(desc(events.seq))
          .limit(1);

        if (newest !== undefined && isSameEvent(normalized(event), toEvent(newest))) return newest;
      }

      const [inserted] = await tx
        .insert(events)
        .values({
          sessionId: event.sessionId,
          turnId: event.turnId,
          seq: sql`(select coalesce(max(${events.seq}), 0) + 1 from ${events} where ${events.sessionId} = ${event.sessionId}::uuid)`,
          type: event.type,
          payload: event.payload,
          createdAt: new Date(event.createdAt),
        })
        .returning();

      // Postgres has no way to return zero rows from a single-row insert; a missing row
      // here would mean the driver contract changed under us.
      if (inserted === undefined) throw new Error("insert into events returned no row");
      return inserted;
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
}
