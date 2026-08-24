/**
 * Whether an event already in the log is the one a caller is about to write.
 *
 * This exists for exactly one question: a store retrying an append whose first attempt failed
 * without a knowable outcome has to decide whether that attempt committed. The only thing it
 * can compare against is the row itself, because a pending event carries no identifier of its
 * own — `seq` is assigned by the append, which is the very thing in doubt.
 *
 * Every field a pending event has is compared, `seq` excepted. Dropping the payload would be a
 * real bug rather than an optimisation: two `agent.message` chunks from one turn, emitted in
 * the same millisecond, agree on everything else, and treating the second as a duplicate of the
 * first would silently drop a line of the assistant's reply.
 */

import { isDeepStrictEqual } from "node:util";
import type { PendingEvent, StoredEvent } from "./ports/event-store.ts";

/** True when `stored` is `pending`, already written. */
export function isSameEvent(pending: PendingEvent, stored: StoredEvent): boolean {
  return (
    stored.type === pending.type &&
    stored.sessionId === pending.sessionId &&
    stored.turnId === pending.turnId &&
    stored.createdAt === pending.createdAt &&
    isDeepStrictEqual(stored.payload, pending.payload)
  );
}
