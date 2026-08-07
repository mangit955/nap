/**
 * Durable append and ordered read for the event log.
 *
 * `append` is what assigns `seq`. Emitters produce events without one; the store is the
 * single place a sequence number comes from, which is what makes `seq` monotonic per
 * session and safe to key replay and dedupe off.
 *
 * No business logic lives here — the store writes what it is given.
 */

import type { NapEvent } from "../events.ts";

/** An event as it exists once persisted: identical to `NapEvent`, `seq` included. */
export type StoredEvent = NapEvent;

/**
 * `Omit` applied to each member of a union rather than to the union as a whole.
 *
 * This is load-bearing rather than pedantic. A bare `Omit<NapEvent, "seq">` collapses the
 * eleven members into one object whose `type` and `payload` are independent unions, so
 * the two stop being correlated: `tool.call` would accept a `turn.failed` payload, and
 * adding `seq` back would no longer produce a `NapEvent`. Distribution needs a naked type
 * parameter, which is the only reason this is a generic helper.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event on its way in, before the store has assigned its sequence number. */
export type PendingEvent = DistributiveOmit<NapEvent, "seq">;

export interface EventStore {
  /** Persists the event and returns it with the assigned `seq`. */
  append(event: PendingEvent): Promise<StoredEvent>;

  /** Events for a session with `seq` strictly greater than `afterSeq`, in order. */
  readFrom(sessionId: string, afterSeq: number): Promise<StoredEvent[]>;
}
