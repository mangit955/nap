/**
 * An `EventStore` that keeps the log in memory.
 *
 * Everything above the persistence layer needs somewhere for events to land, and almost
 * none of it is testing Postgres: a turn-orchestration test asserts that append happened
 * before publish and that `seq` had no gaps, both of which are properties of the caller.
 * Standing in for the database here keeps those tests in the free suite.
 *
 * It holds the same non-duplication rule for a retried append as the real store, for the same
 * reason a fake holds any invariant: a caller whose retry would have written a second copy of
 * an event must not pass here and fail in production.
 *
 * It holds the two invariants the real store is judged on — `seq` starts at 1, increments
 * by one, and is counted **per session** — because a fake that assigned sequence numbers
 * loosely would let a caller with a real ordering bug pass.
 *
 * Events go in and come out as copies. The log is meant to be the record of what happened,
 * and a caller that mutated a payload it read could rewrite history retroactively, which is
 * a failure no database would ever reproduce.
 */

import { isSameEvent } from "@nap/shared/event-identity";
import type {
  AppendOptions,
  EventStore,
  PendingEvent,
  StoredEvent,
} from "@nap/shared/ports/event-store";

function copy(event: StoredEvent): StoredEvent {
  return structuredClone(event);
}

export class InMemoryEventStore implements EventStore {
  readonly #bySession = new Map<string, StoredEvent[]>();

  async append(event: PendingEvent, options: AppendOptions = {}): Promise<StoredEvent> {
    const existing = this.#bySession.get(event.sessionId) ?? [];

    // A retry may be following an append that committed and then lost its acknowledgement. The
    // real store answers this under its advisory lock; here the array is the serialization.
    // Only rows above the caller's watermark are candidates — an identical event below it was
    // durable before the attempt began, so it is somebody else's.
    const watermark = options.retryAfterSeq;
    if (watermark !== undefined) {
      const already = existing.find(
        (stored) => stored.seq > watermark && isSameEvent(event, stored),
      );
      if (already !== undefined) return copy(already);
    }

    const stored = { ...event, seq: existing.length + 1 } as StoredEvent;

    existing.push(copy(stored));
    this.#bySession.set(event.sessionId, existing);

    return copy(stored);
  }

  async readFrom(sessionId: string, afterSeq: number): Promise<StoredEvent[]> {
    const events = this.#bySession.get(sessionId) ?? [];
    return events.filter((event) => event.seq > afterSeq).map(copy);
  }
}
