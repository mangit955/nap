/**
 * Fanout for events that have already been persisted, across every process on the database.
 *
 * `InProcessEventBus` is an emitter keyed by session id, which is correct for exactly one
 * replica and silently wrong for two: a socket on one process never sees a turn run by
 * another, and the chat simply stops moving. This implements the same `EventBus` port over
 * Postgres, so nothing above it changes — `EventSink` still appends then publishes, and
 * `openEventStream` still subscribes, replays and gates on `lastSentSeq`.
 *
 * **A notification is a wake-up signal. The durable log is the delivery.** `publish` sends
 * `{sessionId, seq}` and never the event (see `event-notification.ts` for why that is not
 * negotiable); a notification for a session this process is streaming causes a read from the
 * log; the rows from that read are what subscribers are handed. Three things fall out of it:
 *
 *  - **A missed notification costs latency, not an event.** A catch-up poll runs the same read
 *    unconditionally, so a process that dies between committing an append and sending the
 *    notification leaves an event durable and announced within one poll interval. That is the
 *    whole reason `pg_notify` is *not* inside the append transaction — see design §8.
 *  - **A rolled-back append announces nothing**, because `publish` is only reachable after
 *    `append` has returned, and `append` returns only on commit.
 *  - **Duplicates are impossible even under a duplicated wake-up.** Each session has one cursor
 *    and it only ever moves forwards; every read starts above it.
 *
 * The poll is **one query for every session this process is streaming**, not one per session:
 * a hundred live sessions polled independently would be fifty queries a second of pure
 * overhead against the database that is also serving the turns. `EventTailReader` exists for
 * that shape alone.
 *
 * This process hears its own notifications, and that is deliberate rather than tolerated: the
 * local path and the remote one are then the same path, so there is no second delivery route
 * that only one replica ever exercises.
 */

import { getLogger } from "@nap/shared/logging";
import type { EventBus, EventHandler, Unsubscribe } from "@nap/shared/ports/event-bus";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import {
  decodeHeartbeat,
  decodeNotification,
  EVENT_CHANNEL,
  encodeNotification,
  HEARTBEAT_CHANNEL,
} from "./event-notification.ts";
import type { EventTailReader } from "./event-tail-reader.ts";
import type { NotifyTransport, Unlisten } from "./notify-transport.ts";

/**
 * Frequent enough that a lost notification is not a visible stall, rare enough that the query
 * it costs is noise. Design §8 names two seconds; it is a backstop rather than the mechanism.
 */
export const DEFAULT_POLL_INTERVAL_MS = 2000;

/**
 * How many silent poll intervals before the `LISTEN` connection is called down.
 *
 * Three rather than one, because a single missed echo is a slow tick or a busy event loop and
 * de-registering a healthy pod for that is worse than the two extra seconds of doubt.
 */
const MISSED_HEARTBEATS_BEFORE_DOWN = 3;

/**
 * How far a session's log has been read, and whether that number can be trusted.
 *
 * The two flags are the subtle half. A subscription starts by asking where the log currently
 * ends, because a cursor of zero would hand the subscriber the entire history the first time
 * anything happened — and that question is a query, which an append can commit in the middle
 * of. `known` says the cursor has a value at all; `settled` says a read has actually run
 * against it.
 *
 * **Until it is settled, a notification may pull the cursor backwards**, and that is what
 * closes the only gap this arrangement can otherwise have. `openEventStream` reads its history
 * and the bus reads the head as two independent queries at two independent moments; an event
 * committing between them is in neither snapshot, so a head-derived cursor would sit *above* an
 * event nobody had delivered and the notification announcing it would be discarded as old. A
 * notification naming a `seq` at or below an unsettled cursor is therefore proof that the head
 * was read too late, and it wins. It cannot re-deliver anything, because nothing has been
 * delivered yet.
 *
 * **Once settled the cursor only ever moves forwards.** Notifications genuinely can arrive out
 * of `seq` order — two processes appending to one session commit in lock order but publish
 * whenever each returns — and a cursor that could still walk backwards would answer the late
 * one by re-reading a range it had already handed over.
 */
type Cursor = { after: number; known: boolean; settled: boolean };

export type PostgresNotifyEventBusOptions = {
  /** Where events are actually read from. The notification only says that there are some. */
  reader: EventTailReader;
  transport: NotifyTransport;
  /** How often the catch-up poll and the listener heartbeat run. */
  pollIntervalMs?: number;
  /** Distinguishes this process's heartbeat from every other replica's on the same channel. */
  instanceId?: string;
  /** Injected so the heartbeat's staleness can be tested without waiting it out. */
  now?: () => number;
};

export class PostgresNotifyEventBus implements EventBus {
  readonly #reader: EventTailReader;
  readonly #transport: NotifyTransport;
  readonly #pollIntervalMs: number;
  readonly #instanceId: string;
  readonly #now: () => number;

  readonly #subscribers = new Map<string, Set<EventHandler>>();
  readonly #cursors = new Map<string, Cursor>();

  /**
   * Reads are serialized rather than concurrent.
   *
   * Two overlapping reads of one session would both start above the same cursor and both
   * deliver the same rows, since neither has advanced it yet. Queuing them means a wake-up
   * arriving mid-read is answered by the read after it, which is the same answer one interval
   * later rather than a duplicate now.
   */
  #chain: Promise<void> = Promise.resolve();

  #timer: ReturnType<typeof setInterval> | null = null;
  #unlisten: Unlisten[] = [];
  #started = false;
  #lastEchoAt = 0;

  constructor(options: PostgresNotifyEventBusOptions) {
    this.#reader = options.reader;
    this.#transport = options.transport;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#instanceId = options.instanceId ?? crypto.randomUUID();
    this.#now = options.now ?? Date.now;
  }

  /**
   * Whether this process is still hearing the channel it is listening to.
   *
   * A dead `LISTEN` connection is indistinguishable from a quiet one from the inside, and a
   * socket being open is not proof that the backend is still delivering — so the process
   * announces itself on its own channel every tick and watches for its own announcement coming
   * back. Readiness reads this: a pod whose fanout has degraded to a two-second poll should
   * leave the rotation while another pod's has not. See `docs/scaling-design.md` §24, item 5.
   */
  get listening(): boolean {
    if (!this.#started) return false;
    return this.#now() - this.#lastEchoAt < this.#pollIntervalMs * MISSED_HEARTBEATS_BEFORE_DOWN;
  }

  /** Opens the listener and starts the catch-up poll. Idempotent. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    // Before the first echo can possibly have arrived, so a bus that has only just started is
    // not reported as down for its first interval.
    this.#lastEchoAt = this.#now();

    this.#unlisten = [
      await this.#transport.listen(EVENT_CHANNEL, (payload) => this.#onNotification(payload)),
      await this.#transport.listen(HEARTBEAT_CHANNEL, (payload) => this.#onHeartbeat(payload)),
    ];

    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#pollIntervalMs);
    // Nothing here should hold a process open: the poll is a backstop, not work.
    this.#timer.unref?.();
  }

  /** Closes the listener and stops the poll, then waits for any read already running. */
  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;

    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;

    for (const unlisten of this.#unlisten) await unlisten();
    this.#unlisten = [];

    await this.#chain;
  }

  /**
   * Announces that the session has reached this `seq`. Fire and forget, necessarily — the port
   * returns `void`, and the caller has already made the event durable.
   *
   * A failure here is a missed wake-up rather than a lost event, so it is logged and dropped:
   * throwing would fail a turn over a notification, and the poll delivers the event anyway.
   */
  publish(event: StoredEvent): void {
    const payload = encodeNotification({ sessionId: event.sessionId, seq: event.seq });

    void this.#transport.notify(EVENT_CHANNEL, payload).catch((error: unknown) => {
      getLogger().warn(
        { err: error, sessionId: event.sessionId, seq: event.seq },
        "event notification failed; the catch-up poll will deliver it",
      );
    });
  }

  subscribe(sessionId: string, handler: EventHandler): Unsubscribe {
    const handlers = this.#subscribers.get(sessionId) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.#subscribers.set(sessionId, handlers);

    if (!this.#cursors.has(sessionId)) {
      this.#cursors.set(sessionId, { after: 0, known: false, settled: false });
      this.#enqueue(() => this.#establish(sessionId));
    }

    let live = true;
    return () => {
      // Guarded because a socket can close twice, and the second call must not remove a
      // handler that a *later* subscription for the same session has since added.
      if (!live) return;
      live = false;

      handlers.delete(handler);
      if (handlers.size > 0) return;

      // Nobody on this process is watching the session any more, so its cursor is not worth
      // carrying — and keeping it would make the poll's batched query grow without bound over
      // the life of the process.
      this.#subscribers.delete(sessionId);
      this.#cursors.delete(sessionId);
    };
  }

  /**
   * One catch-up round: announce this process to itself, then read every subscribed session.
   *
   * Exposed so a test can drive it rather than wait for the interval.
   */
  async tick(): Promise<void> {
    void this.#transport
      .notify(HEARTBEAT_CHANNEL, JSON.stringify({ instanceId: this.#instanceId }))
      .catch(() => {
        // Deliberately silent. A failed heartbeat is reported by `listening` going false,
        // which is the signal that matters; a log line per tick during an outage is noise.
      });
    // The send half goes over the pool, so trouble *there* also reads as a down listener. That
    // is not a false reading worth engineering away: readiness pings the same pool for its
    // `database` check and would fail on it anyway, and three consecutive missed echoes is
    // already more patience than a momentarily busy pool needs.

    this.#enqueue(() => this.#drain([...this.#subscribers.keys()]));
    await this.#chain;
  }

  #onNotification(payload: string): void {
    const notification = decodeNotification(payload);
    if (notification === null) return;

    const cursor = this.#cursors.get(notification.sessionId);
    // Every process on the database hears every session's notifications; almost all of them
    // are about sessions nobody here is streaming.
    if (cursor === undefined) return;

    if (!cursor.known) {
      cursor.after = notification.seq - 1;
      cursor.known = true;
    } else if (!cursor.settled && notification.seq - 1 < cursor.after) {
      // The head query resolved *after* this event committed, so it read a log that already
      // contained an event nobody has delivered. See the note on `Cursor`.
      cursor.after = notification.seq - 1;
    }

    this.#enqueue(() => this.#drain([notification.sessionId]));
  }

  #onHeartbeat(payload: string): void {
    if (decodeHeartbeat(payload) !== this.#instanceId) return;
    this.#lastEchoAt = this.#now();
  }

  /** Where the session's log ends now, so a first read does not replay all of it. */
  async #establish(sessionId: string): Promise<void> {
    const cursor = this.#cursors.get(sessionId);
    if (cursor === undefined || cursor.known) return;

    const head = await this.#reader.headSeq(sessionId);

    // Checked again, and by identity, because two things can have happened while the query was
    // in flight. A notification may have arrived, and its `seq` is the better answer — it names
    // an event that must be delivered, where the head is only where the log happened to be. Or
    // the last subscriber may have left and a new one arrived, in which case this is a stale
    // reading about somebody else's cursor.
    if (this.#cursors.get(sessionId) !== cursor || cursor.known) return;
    cursor.after = head;
    cursor.known = true;
  }

  async #drain(sessionIds: string[]): Promise<void> {
    const cursors = new Map<string, number>();
    for (const sessionId of sessionIds) {
      const cursor = this.#cursors.get(sessionId);
      // An unestablished cursor is skipped rather than read from zero: its `#establish` is
      // already queued ahead of the next tick, and reading from zero would replay the log.
      if (cursor === undefined || !cursor.known) continue;
      cursors.set(sessionId, cursor.after);
    }

    const tail = await this.#reader.readTails(cursors);

    // Before delivering rather than after: a handler runs synchronously and may subscribe, and
    // what `settled` records is that a read has been *made* against this cursor, so the head it
    // came from can no longer be overruled.
    for (const sessionId of cursors.keys()) {
      const cursor = this.#cursors.get(sessionId);
      if (cursor !== undefined) cursor.settled = true;
    }

    for (const event of tail) {
      const cursor = this.#cursors.get(event.sessionId);
      // Unsubscribed while the read was in flight, or already delivered by a read that
      // overlapped this one's range.
      if (cursor === undefined || event.seq <= cursor.after) continue;
      cursor.after = event.seq;
      this.#deliver(event);
    }
  }

  #deliver(event: StoredEvent): void {
    // A copy, because a handler is allowed to unsubscribe from inside itself — closing the
    // socket it was delivering to is the ordinary way that happens.
    for (const handler of [...(this.#subscribers.get(event.sessionId) ?? [])]) {
      handler(event);
    }
  }

  /**
   * Queues work behind whatever is already running, and keeps the chain usable afterwards.
   *
   * A rejected link would otherwise wedge every later read behind it, which would stop the
   * chat for every session on this process. The failure is reported and the next tick tries
   * again — the log is durable, so nothing has been lost by waiting.
   */
  #enqueue(work: () => Promise<void>): void {
    this.#chain = this.#chain.then(work).catch((error: unknown) => {
      getLogger().error({ err: error }, "event fanout read failed; retrying on the next poll");
    });
  }
}
