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
 * Both methods read `created_at` back from the row rather than echoing what the caller
 * passed. The column is `timestamptz` and the contract is an ISO-8601 string, so the value
 * is normalized on the way through; taking it from the row in both places is what makes a
 * replayed event byte-identical to the one that was published live.
 *
 * Rows are parsed against the event union on the way out. A row that does not parse is
 * corruption rather than an expected failure, so it throws.
 */

import { type NapEvent, NapEventSchema } from "@nap/shared/events";
import type { EventStore, PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import { and, asc, eq, gt, sql } from "drizzle-orm";
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

export class PostgresEventStore implements EventStore {
  readonly #db: PostgresJsDatabase;

  /**
   * Takes a database rather than a connection string: the store does not own the pool, and
   * a test can hand it the same connection it seeds its rows with.
   */
  constructor(db: PostgresJsDatabase) {
    this.#db = db;
  }

  async append(event: PendingEvent): Promise<StoredEvent> {
    const row = await this.#db.transaction(async (tx) => {
      // Held until the transaction ends, so the read of max(seq) below and the insert that
      // depends on it cannot be interleaved with another writer's.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${event.sessionId}))`);

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
