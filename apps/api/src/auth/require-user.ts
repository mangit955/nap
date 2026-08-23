/**
 * Authorization's first half: nobody reaches a route without being someone.
 *
 * **Deny by default, with a named list of exceptions.** The alternative — a `requireUser()` call
 * at the top of each handler — protects exactly the routes somebody remembered, and the whole
 * failure mode worth designing against is the route added next month by someone who did not know
 * to add the call. Here, a new route is guarded the moment it is registered, and making it public
 * is a deliberate edit to the list below rather than an omission.
 *
 * The list is short on purpose and each entry earns its place:
 *
 *   - `/health`, `/livez` and `/readyz` are polled by things that have no session and never will
 *     — a human with `curl`, and an orchestrator's two probes.
 *   - `/metrics` is scraped by a Prometheus that has no session either, and says nothing but how
 *     many sockets this pod is holding — no user, no project, no session. What keeps it off the
 *     public internet is the NetworkPolicy and the Ingress, neither of which routes to it.
 *   - `/api/auth/*` is how a session is *obtained*; requiring one to reach it is a locked door
 *     with the key on the inside. The library owns every path under that prefix.
 *   - `/auth/providers` says which sign-in buttons to draw, which the page needs before anyone
 *     has signed in, and which tells a stranger nothing they could not learn by pressing one.
 *
 * This only establishes *who* is asking. Whether they may touch a particular project or session
 * is the other half, and it lives with the data — see `ProjectStore` and `SessionRecord`, which
 * take a user id so the filter is in the query rather than in a handler that might forget it.
 */

import { addLogContext } from "@nap/shared/logging";
import type { MiddlewareHandler } from "hono";
import type { Authenticate } from "./auth.ts";

/**
 * What the middleware puts on the context for handlers below it.
 *
 * `isAnonymous` is here rather than looked up again because it arrives in the same session
 * read that produced the id. Nothing authorizes on it — a demo visitor owns their projects
 * exactly as anybody else does — it exists so the parts of the app that talk about accounts
 * can tell a throwaway identity from a real one.
 */
export type AuthVariables = { userId: string; isAnonymous: boolean };

/** Matched exactly, not by prefix: `/healthz` is a different route from `/health`. */
const PUBLIC_PATHS = new Set(["/health", "/livez", "/readyz", "/metrics", "/auth/providers"]);

/** The one prefix, because the auth library owns which paths exist beneath it. */
const PUBLIC_PREFIX = "/api/auth/";

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path) || path.startsWith(PUBLIC_PREFIX);
}

/**
 * Requires a signed-in caller for everything but the public paths.
 *
 * `authenticate` is optional and its absence means *refuse*, not *allow*. An app assembled
 * without authentication should have no reach into anybody's data; the opposite default turns
 * one forgotten line in boot into every project being served to whoever asks.
 */
export function requireUser(authenticate: Authenticate | undefined): MiddlewareHandler<{
  Variables: AuthVariables;
}> {
  return async (c, next) => {
    // A preflight carries no cookies — browsers do not send credentials on one — so it can never
    // be authenticated, and answering it with a 401 surfaces in the browser as a CORS failure
    // rather than as an auth one. CORS middleware normally answers these before we are reached;
    // this is here so the guarantee does not depend on the order two middlewares are registered.
    if (c.req.method === "OPTIONS") return await next();

    if (isPublicPath(new URL(c.req.url).pathname)) return await next();

    const caller = await authenticate?.(c.req.raw.headers);
    if (caller === undefined || caller === null) {
      return c.json({ error: "not signed in" }, 401);
    }

    c.set("userId", caller.userId);
    c.set("isAnonymous", caller.isAnonymous);
    // Who is asking is only knowable here, and everything below this point — including the
    // request's own summary line, which is written after the handler returns — should say so.
    // Enriching the open context rather than nesting a new one is what makes that summary
    // carry it too; see `addLogContext`.
    addLogContext({ userId: caller.userId });
    await next();
  };
}
