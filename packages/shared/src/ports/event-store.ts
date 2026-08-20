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
 * every member into one object whose `type` and `payload` are independent unions, so
 * the two stop being correlated: `tool.call` would accept a `turn.failed` payload, and
 * adding `seq` back would no longer produce a `NapEvent`. Distribution needs a naked type
 * parameter, which is the only reason this is a generic helper.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event on its way in, before the store has assigned its sequence number. */
export type PendingEvent = DistributiveOmit<NapEvent, "seq">;

/** What the caller knows about this append that the store cannot see for itself. */
export interface AppendOptions {
  /**
   * That an earlier attempt at *this same event* failed without a knowable outcome.
   *
   * A connection lost between commit and acknowledgement looks exactly like a connection lost
   * before the commit, and a caller retrying the second case blindly writes the first one twice
   * — a fresh `seq` for an event already in the log, and a duplicated message in somebody's
   * chat. An implementation told this is a retry must establish whether the event is already
   * present, under whatever serialization it appends with, and return the stored row rather
   * than write a second one.
   *
   * Only a caller that has already seen an attempt fail may set it.
   */
  readonly isRetry?: boolean;
}

export interface EventStore {
  /** Persists the event and returns it with the assigned `seq`. */
  append(event: PendingEvent, options?: AppendOptions): Promise<StoredEvent>;

  /** Events for a session with `seq` strictly greater than `afterSeq`, in order. */
  readFrom(sessionId: string, afterSeq: number): Promise<StoredEvent[]>;
}
