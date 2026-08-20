/**
 * `LISTEN`/`NOTIFY` over a postgres.js connection.
 *
 * **`LISTEN` needs a session-mode connection**, and that is the one operational constraint worth
 * getting right here. A listener is a piece of *session* state: a transaction pooler hands the
 * next statement to whichever backend is free, so the `LISTEN` would land on a connection that
 * is then returned to the pool and the process would hear nothing while every query it ran kept
 * working. Neon's pooled endpoint and PgBouncer in transaction mode are both this. postgres.js
 * already treats it that way — `sql.listen` opens a connection of its own with `max: 1` and no
 * idle timeout, and re-issues the `LISTEN` if it ever reconnects — so what this file adds is a
 * connection that is *only* used for that, opened from a URL that may need to be the direct
 * endpoint rather than the pooled one.
 *
 * `notify` is a perfectly ordinary statement and goes through the pool.
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
