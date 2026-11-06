/**
 * How an idle worker learns that a turn request may now be claimable, rather than asking the queue
 * every tenth of a second in case one is.
 *
 * **A claim wake-up claims nothing.** It says "go and ask the queue now", and the claim is what
 * decides, so the bargain is the one `CancelChannel` makes (`docs/adr/0023`): a wake-up may be
 * lost, duplicated, late or about somebody else's request, and each of those costs a claim query
 * or some latency and nothing else. Every worker hears every wake-up; whichever one asks first gets
 * the row, and the rest find nothing. See `docs/adr/0027`.
 *
 * It carries no payload because nothing would be done with one: what is claimable is a question
 * about the whole queue, and only the claim can answer it.
 *
 * **What announces is whatever wrote the row**, after it commits: enqueueing a request, settling a
 * lease (which frees its session for the next request on it), and the janitor orphaning one. Those
 * writers live in `@nap/db`, and each takes the announcing half as a constructor argument.
 */

import type { StopListening } from "./cancel-channel.ts";

/** Called for every wake-up on the channel. */
export type ClaimWakeupHandler = () => void;

/** The half a writer of turn requests needs: say, after committing, that something changed. */
export type ClaimAnnouncer = {
  /**
   * Returns nothing and never throws, like `CancelChannel.announce`: the row is already durable, so
   * a failure here is a wake-up the worker's fallback poll stands in for.
   */
  announce(): void;
};

export interface ClaimChannel extends ClaimAnnouncer {
  /** Resolves once wake-ups are genuinely being heard, not merely requested. */
  listen(handler: ClaimWakeupHandler): Promise<StopListening>;

  /**
   * Whether wake-ups are reaching this process right now, as far as it can tell.
   *
   * A `LISTEN` that answered once can stop delivering later — the socket dies, and every
   * notification sent before it is back is gone — and nothing on the channel itself says so. A
   * worker that reads `false` here polls at its fast interval until this reads `true` again, so a
   * deaf listener costs today's database load rather than a stuck turn.
   */
  hearing(): boolean;
}
