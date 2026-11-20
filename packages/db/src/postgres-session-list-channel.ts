/**
 * "Your session list changed" notices, over `LISTEN`/`NOTIFY` on whatever transport the event bus
 * is already using — so on the one listening socket a process already holds, as the cancel and
 * claim channels are (`docs/adr/0027` D1).
 *
 * **The payload is the owner's user id, and nothing more.** What changed is a question only
 * `GET /sessions` answers, and a row in a notification would be a second copy of one that can
 * disagree with the first (`docs/adr/0010`). Every API pod hears every notice and hands it to the
 * sockets it holds for that user, which is how a change written by a worker reaches a tab whose
 * socket is on another pod.
 *
 * **The owner is looked up here, not by the writer.** A writer settling a turn request knows the
 * session and not whose it is; one indexed read here saves every such writer a join it would only
 * make for this. A project already deleted has no owner left to find, so whatever deletes one
 * names the user instead.
 */

import { getLogger } from "@nap/shared/logging";
import type { StopListening } from "@nap/shared/ports/cancel-channel";
import type {
  SessionListChannel,
  SessionListHandler,
  SessionListOwner,
} from "@nap/shared/ports/session-list-channel";
import { eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import type { NotifyTransport } from "./notify-transport.ts";
import { projects, sessions } from "./schema.ts";

export const SESSION_LIST_CHANNEL = "nap_session_list";

/** A user id is a uuid; anything else on the channel is from somebody else's mistake. */
const PayloadSchema = z.uuid();

export type PostgresSessionListChannelOptions = {
  /**
   * Whether the listening socket is still delivering: the event bus's `listening` in a deployment,
   * which reads its echo over the same socket, as `PostgresClaimChannel` is handed. Absent means
   * "assume so", which is right for a transport inside one process.
   */
  hearing?: () => boolean;
};

export class PostgresSessionListChannel implements SessionListChannel {
  readonly #db: PostgresJsDatabase;
  readonly #transport: NotifyTransport;
  readonly #hearing: () => boolean;

  constructor(
    db: PostgresJsDatabase,
    transport: NotifyTransport,
    options: PostgresSessionListChannelOptions = {},
  ) {
    this.#db = db;
    this.#transport = transport;
    this.#hearing = options.hearing ?? (() => true);
  }

  hearing(): boolean {
    return this.#hearing();
  }

  announce(...owners: SessionListOwner[]): void {
    if (owners.length === 0) return;
    void this.#announce(owners).catch((error: unknown) => {
      getLogger().warn(
        { err: error },
        "session list notice failed; open tabs will see the change at their next read",
      );
    });
  }

  async listen(handler: SessionListHandler, onMissed?: () => void): Promise<StopListening> {
    return await this.#transport.listen(
      SESSION_LIST_CHANNEL,
      (payload) => {
        const userId = PayloadSchema.safeParse(payload);
        if (userId.success) handler(userId.data);
      },
      onMissed,
    );
  }

  async #announce(owners: readonly SessionListOwner[]): Promise<void> {
    for (const userId of await this.#owners(owners)) {
      await this.#transport.notify(SESSION_LIST_CHANNEL, userId);
    }
  }

  /** The distinct users the owners name. A user named directly costs no query. */
  async #owners(owners: readonly SessionListOwner[]): Promise<Set<string>> {
    const users = new Set<string>();
    const projectIds: string[] = [];
    const sessionIds: string[] = [];
    for (const owner of owners) {
      if ("userId" in owner) users.add(owner.userId);
      else if ("projectId" in owner) projectIds.push(owner.projectId);
      else sessionIds.push(owner.sessionId);
    }
    if (projectIds.length > 0) {
      const rows = await this.#db
        .selectDistinct({ userId: projects.userId })
        .from(projects)
        .where(inArray(projects.id, projectIds));
      for (const row of rows) users.add(row.userId);
    }
    if (sessionIds.length > 0) {
      const rows = await this.#db
        .selectDistinct({ userId: projects.userId })
        .from(sessions)
        .innerJoin(projects, eq(projects.id, sessions.projectId))
        .where(inArray(sessions.id, sessionIds));
      for (const row of rows) users.add(row.userId);
    }
    return users;
  }
}
