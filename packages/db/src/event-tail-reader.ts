/**
 * Reading the tail of several sessions' logs at once.
 *
 * A notify-based bus is a wake-up signal followed by a read: the notification says only that
 * session X has reached seq N, and the events themselves come from the durable log. That read
 * happens twice — once per notification, and once per catch-up tick for *every* session this
 * process is streaming. The second one is the reason this is a batched interface rather than a
 * loop over `EventStore.readFrom`: a hundred live sessions polled independently is a hundred
 * queries every tick, which is pure overhead against a database that is also serving turns.
 *
 * `headSeq` exists for the other half of the problem. A bus that starts a session's cursor at
 * zero would hand every subscriber the whole log the first time anything happened, so a
 * subscription needs to know where the log currently ends — and it is a `max(seq)`, not a read
 * of the rows it would otherwise have to fetch and throw away.
 *
 * Kept here rather than on the `EventStore` port because nothing above the persistence layer
 * needs either method: they are how one Postgres-backed component reads what another wrote.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";

/** Where each session's reader has got to: everything strictly above the value is wanted. */
export type SessionCursors = ReadonlyMap<string, number>;

export interface EventTailReader {
  /** The highest `seq` in the session's log, or 0 when it has no events at all. */
  headSeq(sessionId: string): Promise<number>;

  /**
   * Everything above each session's cursor, in **one** query, ordered by `seq` within a
   * session. An empty map reads nothing and asks the database nothing.
   */
  readTails(cursors: SessionCursors): Promise<StoredEvent[]>;
}
