/**
 * How a cancel reaches the worker holding a turn sooner than that worker's next renewal.
 *
 * **A cancel wake-up cancels nothing.** `cancel_requested` on the turn request is the cancel; this
 * only tells whoever is running that request to go and read it now rather than in up to fifteen
 * seconds. That is the same bargain the event fanout makes — a notification is a wake-up signal and
 * the durable row is the truth — and it is why this port can promise so little. A wake-up may be
 * lost, duplicated or late, and every one of those costs latency at worst. See `docs/adr/0023`.
 *
 * Separate from `EventBus` because it is about a request rather than a session. Naming the session
 * would be enough to find a worker and not enough to find the turn: by the time a wake-up lands,
 * that session may be running its next one.
 */

/** Called for every wake-up on the channel, whichever worker's request it names. */
export type CancelWakeupHandler = (requestId: string) => void;

/**
 * Asks for delivery to stop, and resolving does not promise that it has: a handler may go on being
 * called afterwards, so it must stay safe to call. See `PostgresCancelChannel.listen`.
 */
export type StopListening = () => Promise<void>;

export interface CancelChannel {
  /**
   * Tells every listener that this request's row has been flagged. Call it only once it has.
   *
   * Returns nothing and never throws, like `EventBus.publish`: the cancel is already durable, so a
   * failure here is a wake-up that the next renewal stands in for rather than a failed cancel.
   */
  announce(requestId: string): void;

  /** Resolves once wake-ups are genuinely being heard, not merely requested. */
  listen(handler: CancelWakeupHandler): Promise<StopListening>;
}
