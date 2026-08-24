/**
 * `LISTEN`/`NOTIFY` over a postgres.js connection.
 *
 * Two connections rather than one, and which is which is the whole point: `listen` goes to a
 * connection of its own, opened by `createListenerConnection`, which is where the reasoning
 * about session mode and transaction poolers is written down. `notify` is a perfectly ordinary
 * statement and goes through the pool.
 *
 * postgres.js does most of the work — `sql.listen` opens its own `max: 1` socket and re-issues
 * the `LISTEN` if it reconnects — so what this adds is the separation and the port.
 *
 * Reconnecting silently is a mixed blessing: the channel comes back on its own, and nothing
 * tells the process it ever went away. `PostgresNotifyEventBus` covers that with its own
 * heartbeat rather than reaching in here for a socket's state.
 */

import type { Sql } from "postgres";
import type { NotificationHandler, NotifyTransport, Unlisten } from "./notify-transport.ts";

export type PostgresNotifyTransportOptions = {
  /** The pooled connection. Used for `pg_notify` and nothing else. */
  notifier: Sql;
  /** A connection of this transport's own, in session mode. Used for `LISTEN` and nothing else. */
  listener: Sql;
};

export class PostgresNotifyTransport implements NotifyTransport {
  readonly #notifier: Sql;
  readonly #listener: Sql;

  constructor(options: PostgresNotifyTransportOptions) {
    this.#notifier = options.notifier;
    this.#listener = options.listener;
  }

  async notify(channel: string, payload: string): Promise<void> {
    // `pg_notify` rather than the `NOTIFY` statement, because the statement takes the channel
    // and payload as literals — so a payload would have to be interpolated into SQL, and this
    // one is JSON built from values that came off a request.
    await this.#notifier`select pg_notify(${channel}, ${payload})`;
  }

  async listen(channel: string, handler: NotificationHandler): Promise<Unlisten> {
    const subscription = await this.#listener.listen(channel, handler);
    return async () => {
      await subscription.unlisten();
    };
  }
}
