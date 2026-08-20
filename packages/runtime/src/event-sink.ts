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
 */

import type { NapEventOf } from "@nap/shared/events";
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

export class EventSink {
  #chain: Promise<void> = Promise.resolve();
  #failure: unknown = null;
  #terminal: NapEventOf<"turn.completed"> | NapEventOf<"turn.failed"> | null = null;
  readonly #sleep: (ms: number) => Promise<void>;

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
  };

  /** Resolves once every event emitted so far is persisted and published. */
  async drain(): Promise<void> {
    await this.#chain;
    if (this.#failure !== null) throw this.#failure;
  }

  /**
   * The append, with a bounded retry around it.
   *
   * Every attempt after the first says so, because an attempt that failed may have been an
   * attempt that committed and then lost its acknowledgement — indistinguishable from here, and
   * answerable only by the store, under the serialization it appends with.
   */
  async #append(event: PendingEvent): Promise<StoredEvent> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.store.append(event, attempt === 1 ? undefined : { isRetry: true });
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
