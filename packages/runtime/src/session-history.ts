/**
 * A session's event log as one runtime call has read it, kept and topped up rather than read
 * again from the start.
 *
 * A turn needs the log at several moments: before its prompt is logged, before each repair's
 * prompt, when it compacts, when it finishes a repository job. Each of those used to be
 * `readFrom(sessionId, 0)`, and the log is not small — the agent persists its streamed text
 * every few hundred milliseconds and a file write carries the whole file — so a job with three
 * repairs read the entire session four or five times over. Holding what was read and asking only
 * for what came after it makes every read after the first cost what was appended since.
 *
 * **This is exact, not approximate, and the reason is the store's.** `seq` is assigned under a
 * per-session serialization and committed in order, so once `n` is visible nothing at or below
 * it can still appear. `readFrom(sessionId, n)` therefore returns precisely what a full read would
 * add, whoever wrote it — including an event some other process appended to this session.
 *
 * **Every read returns a fresh array.** A caller's history is a snapshot of a moment: the one a
 * turn hands its context engine is the log *before* its own prompt, and it is used after the
 * prompt has been appended. Handing out the array this keeps would grow the prompt into it, and
 * the model would be sent its own request twice.
 */

import type { EventStore, StoredEvent } from "@nap/shared/ports/event-store";

export class SessionHistory {
  readonly #store: EventStore;
  readonly #sessionId: string;
  readonly #events: StoredEvent[] = [];

  constructor(store: EventStore, sessionId: string) {
    this.#store = store;
    this.#sessionId = sessionId;
  }

  /** The whole log as it stands now, oldest first — one read of whatever is new since the last. */
  async read(): Promise<StoredEvent[]> {
    const fresh = await this.#store.readFrom(this.#sessionId, this.#head());

    // Filtered by `seq` rather than trusted, so two reads that overlapped — both asking from
    // the same head — cannot each add the same event.
    for (const event of fresh) if (event.seq > this.#head()) this.#events.push(event);

    return [...this.#events];
  }

  #head(): number {
    return this.#events.at(-1)?.seq ?? 0;
  }
}
