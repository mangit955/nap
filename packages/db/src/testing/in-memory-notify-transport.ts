/**
 * A `NotifyTransport` where the channels are a map, and the "processes" are objects.
 *
 * Two things this makes testable that a real database makes awkward. **Several processes on one
 * channel**: a `NotifyHub` is the database, and each transport taken from it is a replica, so
 * "two pods subscribed to one session both deliver" is an assertion rather than a container.
 * And **a channel that has stopped working**: `suppress()` drops every notification while
 * leaving the sender's promise resolving, which is exactly what a wake-up lost between two
 * processes looks like — and it is the only way to watch the catch-up poll be the thing that
 * delivers, rather than assuming it.
 *
 * Delivery is synchronous, like Postgres's is from the listener's point of view: the handler
 * runs when the notification arrives, and the bus above decides what is queued.
 */

import type { NotificationHandler, NotifyTransport, Unlisten } from "../notify-transport.ts";

/** Stands in for the database every transport is connected to. */
export class NotifyHub {
  readonly #listeners = new Map<string, Set<NotificationHandler>>();
  #suppressed = false;

  /** Every notification after this is dropped, as a lost wake-up rather than an error. */
  suppress(): void {
    this.#suppressed = true;
  }

  resume(): void {
    this.#suppressed = false;
  }

  /** How many notifications have been sent, dropped ones included. */
  sent = 0;

  /** One process's connection to this hub. */
  connect(): NotifyTransport {
    return {
      notify: async (channel, payload) => {
        this.sent += 1;
        if (this.#suppressed) return;
        for (const handler of [...(this.#listeners.get(channel) ?? [])]) handler(payload);
      },
      listen: async (channel, handler) => {
        const handlers = this.#listeners.get(channel) ?? new Set<NotificationHandler>();
        handlers.add(handler);
        this.#listeners.set(channel, handlers);

        const unlisten: Unlisten = async () => {
          handlers.delete(handler);
        };
        return unlisten;
      },
    };
  }
}
