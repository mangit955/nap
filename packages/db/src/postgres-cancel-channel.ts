/**
 * Cancel wake-ups over `LISTEN`/`NOTIFY`, on whatever transport the event bus is already using.
 *
 * **A transport rather than a connection, and that is the connection budget.** Every channel on one
 * `PostgresNotifyTransport` shares the one socket postgres.js holds for its listener, and comes back
 * with it after a reconnect, so a worker hearing cancels holds no more connections than a worker
 * that does not. `notify` is one short statement through the pool, once per click on stop.
 *
 * The payload is the request id and nothing else, thirty-six bytes against Postgres's 8000. A
 * malformed one is ignored rather than trusted: every process on the database shares this channel,
 * so an older or newer replica mid-rollout is a thing that can actually happen.
 */

import { getLogger } from "@nap/shared/logging";
import type {
  CancelChannel,
  CancelWakeupHandler,
  StopListening,
} from "@nap/shared/ports/cancel-channel";
import { z } from "zod";
import type { NotifyTransport } from "./notify-transport.ts";

export const CANCEL_CHANNEL = "nap_cancel";

const RequestIdSchema = z.uuid();

export class PostgresCancelChannel implements CancelChannel {
  readonly #transport: NotifyTransport;

  constructor(transport: NotifyTransport) {
    this.#transport = transport;
  }

  announce(requestId: string): void {
    void this.#transport.notify(CANCEL_CHANNEL, requestId).catch((error: unknown) => {
      getLogger().warn(
        { err: error, requestId },
        "cancel notification failed; the worker will find the flag at its next renewal",
      );
    });
  }

  /**
   * After a reconnect, the stop this returns resolves and delivery continues: postgres.js puts each
   * channel back under a new listener entry, so the one this closes over no longer matches anything.
   * Observed under Bun, and not worth working around, because the only caller stops during shutdown,
   * after its drain, when a wake-up has nothing left to find and the process is about to exit.
   */
  async listen(handler: CancelWakeupHandler): Promise<StopListening> {
    return await this.#transport.listen(CANCEL_CHANNEL, (payload) => {
      const requestId = RequestIdSchema.safeParse(payload);
      if (requestId.success) handler(requestId.data);
    });
  }
}
