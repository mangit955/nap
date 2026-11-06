/**
 * Append, then publish — the ordering rule, written down once.
 *
 * Two things in the runtime emit events: a turn, and the lifecycle operations around it
 * (putting a project away, starting one back up). Both have to write an event to the store
 * *before* handing it to the bus. A subscriber that received an event which was never written
 * would be shown history that does not exist, and it would then reconnect, replay from the
 * log, and find the event gone.
 *
 * Turns a stream of synchronous emissions into an ordered append-then-publish pipeline.
 * `onEvent` cannot be awaited — the agent calls it mid-loop and carries on — but appending is
 * a database write. Queuing each event onto a promise chain gives three things at once:
 * appends happen in emission order, an event is published only after its own append has
 * returned, and `drain()` gives the caller a point at which everything it emitted is durable.
 *
 * The first failure stops the pipeline. Continuing would publish events whose predecessors
 * were never written, which is the exact hole this ordering exists to close.
 *
 * A failure only counts once the append has been *retried*, though. Under concurrency a
 * dropped pooled connection is routine rather than exceptional, and treating each one as fatal
 * throws away a whole turn along with its repair budget. `append-retry.ts` holds which failures
 * are worth another attempt and how long to wait; what belongs here is that the retry happens
 * inside the chain link, so the event behind the one being retried cannot overtake it.
 *
 * **Some events are known only later, and the turn does not wait for them.** A new sandbox's
 * `preview.ready` waits on a dev server that can take twenty seconds, and the agent has no use
 * for it. `eventually` takes the promise of such an event and writes it the moment it is known,
 * wherever the stream has got to. Two places it may never land, and the sink enforces both rather
 * than leaving them to call sites: **after an ending** — a `turn.completed`, `turn.failed` or
 * `job.completed` emitted while one is outstanding is held, with everything emitted after it,
 * until it is known — and **after its owner has stopped writing**, which is what `settle` is for:
 * the runtime settles before it returns, because a write after that is a write without a lease.
 * `drain` waits for one only when an ending is held behind it, since drain is called all through
 * a turn and waiting there would be the very wait this removes.
 */

import type { NapEvent, NapEventOf } from "@nap/shared/events";
import { getLogger } from "@nap/shared/logging";
import type { EventBus } from "@nap/shared/ports/event-bus";
import type { EventStore, PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import { APPEND_ATTEMPTS, appendBackoffMs, isTransientAppendFailure } from "./append-retry.ts";
import { eventLogLine } from "./turn-log.ts";

/** Seams a test needs; production takes the defaults. */
export interface EventSinkOptions {
  /** Injectable so a test can assert the backoff schedule without waiting it out. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The events after which nothing promised to that turn or job may appear. */
const ENDINGS: ReadonlySet<NapEvent["type"]> = new Set([
  "turn.completed",
  "turn.failed",
  "job.completed",
]);

export class EventSink {
  #chain: Promise<void> = Promise.resolve();
  #failure: unknown = null;
  #terminal: NapEventOf<"turn.completed"> | NapEventOf<"turn.failed"> | null = null;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Events promised and not yet known, each resolving once it is on the chain or known absent. */
  readonly #outstanding = new Set<Promise<void>>();
  /** An ending, and everything emitted after it, waiting on `#outstanding`. Null when none is. */
  #held: PendingEvent[] | null = null;

  /**
   * The newest `seq` this sink has seen durably appended, per session.
   *
   * A retry needs it to tell its own lost append from an identical event that was already in
   * the log — content alone cannot, because a turn legitimately emits the same event twice
   * running. Keyed by session rather than held as one number because `emit` takes the session
   * from the event, so nothing here guarantees a sink only ever sees one.
   */
  readonly #appended = new Map<string, number>();

  constructor(
    private readonly store: EventStore,
    private readonly bus: EventBus,
    options: EventSinkOptions = {},
  ) {
    this.#sleep = options.sleep ?? wait;
  }

  /** How the turn ended, as recorded — null until it has, and for anything that is not a turn. */
  get terminal(): NapEventOf<"turn.completed"> | NapEventOf<"turn.failed"> | null {
    return this.#terminal;
  }

  /**
   * Forgets the previous turn's ending, before another turn is run through this sink.
   *
   * A job is several turns — the prompt, then up to three repairs — and they share one sink,
   * because sharing it is what keeps their events on a single append-then-publish chain. Without
   * this, a repair turn would be read as having ended the moment it started, on the turn before
   * it, and the loop would arbitrate the same claim twice.
   */
  beginTurn(): void {
    this.#terminal = null;
  }

  readonly emit = (event: PendingEvent): void => {
    if (this.#held !== null) {
      this.#held.push(event);
      return;
    }
    if (this.#outstanding.size > 0 && ENDINGS.has(event.type)) {
      this.#held = [event];
      return;
    }
    this.#enqueue(event);
  };

  /**
   * An event that will be known later, written as soon as it is — or nothing, if it resolves to
   * `null` or rejects. See the module comment for the two places it can never land.
   */
  eventually(event: Promise<PendingEvent | null>): void {
    const known: Promise<void> = event
      .then(
        // Straight onto the chain, past anything held: the held ending is waiting for exactly
        // this, so it has to go first.
        (resolved) => {
          if (resolved !== null) this.#enqueue(resolved);
        },
        (error: unknown) => {
          getLogger().warn({ err: error }, "a promised event could not be produced");
        },
      )
      .finally(() => {
        this.#outstanding.delete(known);
        if (this.#outstanding.size > 0 || this.#held === null) return;
        const held = this.#held;
        this.#held = null;
        // Through `emit` again rather than straight onto the chain, so an ending among them
        // meets whatever has been promised since.
        for (const waiting of held) this.emit(waiting);
      });
    this.#outstanding.add(known);
  }

  #enqueue(event: PendingEvent): void {
    this.#chain = this.#chain.then(async () => {
      if (this.#failure !== null) return;
      try {
        const stored = await this.#append(event);
        this.bus.publish(stored);
        this.#record(stored);
        // After the append, so a logged event is one that really exists in the log. Reading
        // the context at this point rather than capturing a logger up front is what keeps the
        // line under the turn that emitted it.
        const line = eventLogLine(stored);
        getLogger()[line.level](line.fields, "event");
      } catch (error) {
        this.#failure = error;
      }
    });
  }

  /**
   * Resolves once every event emitted so far is persisted and published.
   *
   * Including an ending held for a promised event, which is therefore waited for here — but only
   * then. A promised event with nothing held behind it is not "emitted so far", and waiting for
   * it at every drain would hold the turn up on it after all.
   */
  async drain(): Promise<void> {
    while (this.#held !== null) await Promise.all(this.#outstanding);
    await this.#chain;
    if (this.#failure !== null) throw this.#failure;
  }

  /**
   * Resolves once everything promised is known and everything emitted is durable — the point
   * after which this sink will write nothing more unless asked to. Whoever owns the sink calls
   * it before giving up the right to write.
   */
  async settle(): Promise<void> {
    while (this.#outstanding.size > 0) await Promise.all(this.#outstanding);
    await this.drain();
  }

  /**
   * The append, with a bounded retry around it.
   *
   * Every attempt after the first carries the watermark, because an attempt that failed may
   * have been an attempt that committed and then lost its acknowledgement — indistinguishable
   * from here, and answerable only by the store, under the serialization it appends with.
   */
  async #append(event: PendingEvent): Promise<StoredEvent> {
    const watermark = this.#appended.get(event.sessionId) ?? 0;

    for (let attempt = 1; ; attempt += 1) {
      try {
        const stored = await this.store.append(
          event,
          attempt === 1 ? undefined : { retryAfterSeq: watermark },
        );
        this.#appended.set(stored.sessionId, stored.seq);
        return stored;
      } catch (error) {
        if (attempt >= APPEND_ATTEMPTS || !isTransientAppendFailure(error)) throw error;

        const delayMs = appendBackoffMs(attempt);
        getLogger().warn(
          { sessionId: event.sessionId, eventType: event.type, attempt, delayMs, err: error },
          "event append failed, retrying",
        );
        await this.#sleep(delayMs);
      }
    }
  }

  #record(event: StoredEvent): void {
    if (event.type === "turn.completed" || event.type === "turn.failed") this.#terminal = event;
  }
}
