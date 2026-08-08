/**
 * An `EventBus` backed by a map of subscriber sets.
 *
 * Fanout is per session, so a subscriber watching one chat is never handed another's
 * events — the same isolation the WebSocket endpoint depends on, made testable without a
 * socket.
 *
 * Delivery is synchronous and in publish order, which is what lets a test assert that an
 * event was published *after* it was appended by recording both in one array. A handler
 * that throws would take the publisher down with it, so it does: swallowing it here would
 * hide a broken subscriber behind a green test.
 */

import type { EventBus, EventHandler, Unsubscribe } from "@nap/shared/ports/event-bus";
import type { StoredEvent } from "@nap/shared/ports/event-store";

export class InMemoryEventBus implements EventBus {
  readonly #bySession = new Map<string, Set<EventHandler>>();

  publish(event: StoredEvent): void {
    // A copy of the set, so a handler that unsubscribes during delivery cannot change what
    // the current publish is iterating over.
    for (const handler of [...(this.#bySession.get(event.sessionId) ?? [])]) {
      handler(event);
    }
  }

  subscribe(sessionId: string, handler: EventHandler): Unsubscribe {
    const handlers = this.#bySession.get(sessionId) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.#bySession.set(sessionId, handlers);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#bySession.delete(sessionId);
    };
  }
}
