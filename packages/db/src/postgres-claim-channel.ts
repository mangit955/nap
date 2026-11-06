/**
 * Claim wake-ups over `LISTEN`/`NOTIFY`, on whatever transport the event bus is already using.
 *
 * **The same transport, so the same socket.** Every channel on one `PostgresNotifyTransport` shares
 * the one listening connection postgres.js holds, and comes back with it after a reconnect, so a
 * worker hearing claim wake-ups holds no more connections than one that does not — exactly as the
 * cancel channel arranged (`docs/adr/0023` D4). `notify` is one short statement through the pool,
 * once per request enqueued and once per lease given back.
 *
 * The payload is empty, because what is claimable is a question only the claim can answer. Anything
 * that does arrive on the channel is treated as a wake-up whatever it says: the worst a stray one
 * can do is cost a claim query.
 *
 * **Whether it is hearing is not its own to know.** A `LISTEN` that answered once can stop
 * delivering, and nothing on this channel would say so. The event bus already sends itself an echo
 * over the same socket every couple of seconds and watches for it to come back, so the composition
 * hands that answer in rather than this paying for a second heartbeat.
 */

import { getLogger } from "@nap/shared/logging";
import type { StopListening } from "@nap/shared/ports/cancel-channel";
import type { ClaimChannel, ClaimWakeupHandler } from "@nap/shared/ports/claim-channel";
import type { NotifyTransport } from "./notify-transport.ts";

export const CLAIM_CHANNEL = "nap_claimable";

export type PostgresClaimChannelOptions = {
  /**
   * Whether the listening socket is still delivering. The event bus's `listening` in a deployment,
   * which reads its echo over the same socket. Absent means "assume so", which is what a test of
   * something else wants.
   */
  hearing?: () => boolean;
};

export class PostgresClaimChannel implements ClaimChannel {
  readonly #transport: NotifyTransport;
  readonly #hearing: () => boolean;

  constructor(transport: NotifyTransport, options: PostgresClaimChannelOptions = {}) {
    this.#transport = transport;
    this.#hearing = options.hearing ?? (() => true);
  }

  announce(): void {
    void this.#transport.notify(CLAIM_CHANNEL, "").catch((error: unknown) => {
      getLogger().warn(
        { err: error },
        "claim notification failed; an idle worker will find the request at its next poll",
      );
    });
  }

  /** After a reconnect the stop this returns may not stop delivery; see `PostgresCancelChannel`. */
  async listen(handler: ClaimWakeupHandler): Promise<StopListening> {
    return await this.#transport.listen(CLAIM_CHANNEL, () => handler());
  }

  hearing(): boolean {
    return this.#hearing();
  }
}
