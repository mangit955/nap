/**
 * Fanout for events that have already been persisted, within one process.
 *
 * v1 runs a single API process, so "the bus" is an emitter keyed by session id: the
 * WebSocket endpoint subscribes per connection, and the turn loop publishes. The port is
 * what keeps a cross-process transport additive later — nothing above it knows this is
 * in-process.
 *
 * The ordering rule that matters lives at the call site, not here: append to the
 * `EventStore` first, publish second. Delivery is therefore synchronous and in publish
 * order — an event that only arrived on a later tick would let a caller observe "published"
 * before any subscriber had it, and the invariant is about what a client can see.
 *
 * A handler that throws takes the publisher down with it. That is deliberate: swallowing it
 * would hide a broken subscriber behind a green test and a silent gap in someone's chat.
 */

import { EventEmitter } from "node:events";
import type { EventBus, EventHandler, Unsubscribe } from "@nap/shared/ports/event-bus";
import type { StoredEvent } from "@nap/shared/ports/event-store";

export class InProcessEventBus implements EventBus {
  readonly #emitter = new EventEmitter<Record<string, [StoredEvent]>>();

  constructor() {
    // One session can have as many subscribers as it has open browser tabs, and Node's
    // default ceiling of 10 would turn ordinary use into a warning per connection.
    this.#emitter.setMaxListeners(0);
  }

  publish(event: StoredEvent): void {
    this.#emitter.emit(event.sessionId, event);
  }

  subscribe(sessionId: string, handler: EventHandler): Unsubscribe {
    this.#emitter.on(sessionId, handler);
    return () => {
      this.#emitter.off(sessionId, handler);
    };
  }
}
