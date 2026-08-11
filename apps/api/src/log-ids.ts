/**
 * Which session and project a request is about, read off the URL.
 *
 * Read from the raw path rather than from route parameters because **Hono does not resolve
 * route parameters for a wildcard middleware** — `c.req.param("sessionId")` inside
 * `app.use("*", …)` is `undefined` even on a request to `/sessions/:sessionId/turns`, since the
 * matched route there is `*` and has no parameters of its own. That is silent: the field is
 * simply absent, which looks exactly like a request that had no session to begin with, and it
 * is why every turn and cancel had been logged without one.
 *
 * The alternative — enriching the context from inside each handler, where the parameter does
 * resolve — puts a line in every route that someone will one day forget, and would come too
 * late for the 401s and 404s that never reach a handler at all.
 */

import type { LogContext } from "@nap/shared/logging";

/**
 * Ids are uuids everywhere in this system, and anything else in that position is a request
 * for a resource that cannot exist. Checking the shape keeps arbitrary caller-controlled text
 * out of the fields people grep by — a `projectId` that is not a project id makes a search
 * over that key answer wrongly, which is worse than the field being absent.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The collection segment that precedes each id, and the field it names. */
const COLLECTIONS: Record<string, "sessionId" | "projectId"> = {
  sessions: "sessionId",
  projects: "projectId",
};

export function idsFromRequest(url: URL): LogContext {
  const ids: LogContext = {};

  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  for (const [index, segment] of segments.entries()) {
    const field = COLLECTIONS[segment];
    const value = segments[index + 1];
    if (field !== undefined && value !== undefined && UUID.test(value)) ids[field] = value;
  }

  // The event stream names its session in the query rather than in the path, because a socket
  // is opened at one URL for every session.
  const sessionId = url.searchParams.get("sessionId");
  if (sessionId !== null && UUID.test(sessionId)) ids.sessionId = sessionId;

  return ids;
}
