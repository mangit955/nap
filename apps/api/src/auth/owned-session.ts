/**
 * Authorization's second half, for everything addressed by a session id.
 *
 * `requireUser` establishes *who* is asking. This answers *may they touch this session* — and it
 * is one function rather than a check repeated in four handlers because the four have to agree.
 * A files route that 404s where a turns route 403s is an information leak assembled out of two
 * individually reasonable decisions.
 *
 * Sessions have no owner column: they hang off a project, and the project has the `user_id`.
 * `SessionRecord` carries it down from the join the store already performs.
 *
 * **A session belonging to someone else is a 404, not a 403.** A 403 says "this exists and is not
 * yours", which is a fact about another person's data that a stranger should not be able to
 * establish. The two cases are answered identically on purpose.
 */

import type { SessionRecord, SessionStore } from "@nap/shared/ports/session-store";
import type { Result } from "@nap/shared/result";
import { parseSessionId } from "../files/params.ts";

export type SessionAccessError = {
  status: 400 | 404;
  message: string;
};

/**
 * The session named by the path, if it exists and belongs to the caller.
 *
 * A malformed id is still a 400 — that is a statement about the request rather than about what
 * is behind it, and it says nothing a caller did not already know from what they typed.
 */
export async function findOwnedSession(
  sessions: SessionStore,
  raw: string | undefined,
  userId: string,
): Promise<Result<SessionRecord, SessionAccessError>> {
  const sessionId = parseSessionId(raw);
  if (!sessionId.ok) return { ok: false, error: { status: 400, message: sessionId.error.message } };

  const session = await sessions.get(sessionId.value);
  if (session === null || session.userId !== userId) {
    return { ok: false, error: { status: 404, message: "no such session" } };
  }

  return { ok: true, value: session };
}
