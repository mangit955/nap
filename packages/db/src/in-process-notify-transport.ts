/**
 * A `NotifyTransport` whose only listener is this process.
 *
 * For the arrangement with no `LISTEN` connection (`NAP_EVENT_BUS=in-process`), where one process
 * serves the sockets and writes every row, so a notification never has anywhere else to go. Only
 * the session list's notices use it there; the event bus has its own in-process implementation.
 * Delivery is synchronous, as a notification from Postgres is from its listener's point of view.
 */

import type { NotificationHandler, NotifyTransport, Unlisten } from "./notify-transport.ts";

export class InProcessNotifyTransport implements NotifyTransport {
  readonly #listeners = new Map<string, Set<NotificationHandler>>();

  async notify(channel: string, payload: string): Promise<void> {
    for (const handler of [...(this.#listeners.get(channel) ?? [])]) handler(payload);
  }

  async listen(channel: string, handler: NotificationHandler): Promise<Unlisten> {
    const handlers = this.#listeners.get(channel) ?? new Set<NotificationHandler>();
    handlers.add(handler);
    this.#listeners.set(channel, handlers);
    return async () => {
      handlers.delete(handler);
    };
  }
}
