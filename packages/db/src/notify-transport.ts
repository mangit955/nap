/**
 * The wake-up channel, as a seam.
 *
 * `PostgresNotifyEventBus` is two things at once: bookkeeping about who is subscribed and how
 * far each session's cursor has got, and a Postgres `LISTEN`/`NOTIFY` pair. The bookkeeping is
 * where the mistakes live — a dropped event, an event delivered twice, a cursor that walks
 * backwards — and it is worth testing without a container. So the channel is a port with a fake,
 * and the bus never mentions a connection.
 *
 * A payload is a string because that is what `pg_notify` carries. Everything about *what* is in
 * it belongs to `event-notification.ts`.
 */

/** Called for every notification on the channel, including this process's own. */
export type NotificationHandler = (payload: string) => void;

/** Stops delivery. Idempotent; safe to call after the transport has been closed. */
export type Unlisten = () => Promise<void>;

export interface NotifyTransport {
  /**
   * Announces one payload to every listener on the channel, this process included.
   *
   * Rejects when the notification could not be sent. Callers are expected to treat that as a
   * missed wake-up rather than a failure of the thing being announced — the event it refers to
   * is already durable, and the catch-up poll is what delivers it.
   */
  notify(channel: string, payload: string): Promise<void>;

  /** Resolves once the channel is genuinely being listened to, not merely requested. */
  listen(channel: string, handler: NotificationHandler): Promise<Unlisten>;
}
