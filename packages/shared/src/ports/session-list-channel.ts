/**
 * How an open tab learns that its owner's session list changed, rather than reading the whole list
 * every few seconds in case it did.
 *
 * **A notice carries no rows.** It names whose list changed, and the tab answers it by reading
 * `GET /sessions` again, so that read stays the one place a row is built. The bargain is the one
 * `ClaimChannel` makes (`docs/adr/0027`): a notice may be lost, duplicated, late or about a change
 * that moved nothing visible, and each of those costs a list read or some latency and nothing else.
 * The tab keeps a slow poll behind it for the ones that get lost.
 *
 * **What announces is whatever wrote the row**, after it commits: a request queued, claimed or
 * settled, a project created, renamed, titled, closed or deleted, a session's navigation changed,
 * a pull request or its feedback recorded. Those writers live in `@nap/db`, and each takes the
 * announcing half as a constructor option. `test/session-list-writers.test.ts` is what notices a
 * writer that does not.
 */

import type { StopListening } from "./cancel-channel.ts";

/**
 * Whose list changed, named however the writer knows it. A writer settling a request knows its
 * session and not its owner, so the announcer looks the owner up rather than every writer joining
 * to `projects` for it.
 */
export type SessionListOwner = { userId: string } | { projectId: string } | { sessionId: string };

/** Called with the user whose list changed, for every notice on the channel. */
export type SessionListHandler = (userId: string) => void;

/** The half a writer needs: say, after committing, that these owners' lists changed. */
export type SessionListAnnouncer = {
  /**
   * Returns nothing and never throws: the row is already durable, so a failure here is a notice the
   * tab's slow poll stands in for, and must not fail the write that caused it.
   */
  announce(...owners: SessionListOwner[]): void;
};

export interface SessionListChannel extends SessionListAnnouncer {
  /**
   * Resolves once notices are genuinely being heard, not merely requested. `onMissed` is called
   * when the listener has come back from a drop, during which any user's notice may have been
   * lost: its listener answers as though every user's list had changed.
   */
  listen(handler: SessionListHandler, onMissed?: () => void): Promise<StopListening>;

  /**
   * Whether notices are reaching this process right now, as far as it can tell. A `LISTEN` that
   * answered once can stop delivering, and nothing on the channel says so; a tab told it is live by
   * a process that has gone deaf would wait out its slow backstop for every change. So a process
   * that reads `false` here refuses and closes its `/ws/account` sockets, and their tabs read on
   * their short timer until it hears again — as a worker that cannot hear claims polls fast
   * (`docs/adr/0027` D4).
   */
  hearing(): boolean;
}
