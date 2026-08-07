/**
 * In-process fanout for events that have already been persisted.
 *
 * The ordering rule that matters lives at the call site, not here: append to the
 * `EventStore` first, publish second. A client that receives an event which was never
 * written would be shown history that does not exist.
 */

import type { StoredEvent } from "./event-store.ts";

export type EventHandler = (event: StoredEvent) => void;

/** Returned by `subscribe`; calling it stops delivery. */
export type Unsubscribe = () => void;

export interface EventBus {
  publish(event: StoredEvent): void;
  subscribe(sessionId: string, handler: EventHandler): Unsubscribe;
}
