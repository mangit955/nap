/**
 * That no route escapes a decision.
 *
 * `authorization.test.ts` proves each guarded route behaves; this proves the *list* is complete.
 * They are separate because they fail for different reasons and a reader should be able to tell
 * which: a red test here means somebody added a route and nobody classified it, which is the
 * failure the whole deny-by-default design exists to make loud.
 *
 * It works by enumerating what the router actually registered rather than by reading a list
 * somebody maintains — `app.routes` is Hono's own record of every `app.get`/`post`/`use` call.
 * A list maintained by hand would be exactly as forgettable as the `requireUser()` call this
 * design replaced.
 */

import { FAKE_OWNER } from "@nap/db/testing/in-memory-project-store";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { isPublicPath } from "./require-user.ts";
import { fullyWiredDeps, GUARDED_ROUTES, PUBLIC_ROUTES } from "./route-table.ts";

/**
 * Middleware registers as a route on `*`, and so does the auth handler's own wildcard. Neither
 * is a route anybody can call, so neither is something to classify.
 */
const NOT_A_ROUTE = new Set(["*", "/*"]);

function registeredRoutes(): { method: string; path: string }[] {
  const app = createApp({
    logger: createLogger({ level: "silent" }, { write: () => {} }),
    authenticate: async () => ({ userId: FAKE_OWNER, isAnonymous: false }),
    ...fullyWiredDeps(),
  });

  return app.routes
    .filter((route) => !NOT_A_ROUTE.has(route.path))
    .map((route) => ({ method: route.method, path: route.path }));
}

/** `GET /projects` — the form both tables are written in. */
const asKey = (route: { method: string; path: string }) => `${route.method} ${route.path}`;

describe("every registered route is classified", () => {
  it("has a table entry for each one", () => {
    // The failure message names the offending routes, because "the coverage test failed" with
    // no route in it sends the reader to read the whole router.
    const classified = new Set([
      ...PUBLIC_ROUTES.map(asKey),
      ...GUARDED_ROUTES.map((route) => asKey(route)),
    ]);

    const unclassified = registeredRoutes()
      .map(asKey)
      .filter((key) => !classified.has(key));

    expect(unclassified).toEqual([]);
  });

  it("classifies no route that is not registered", () => {
    // The other direction, and it matters as much: a table entry for a route that has been
    // renamed or removed is an authorization test passing against nothing at all.
    const registered = new Set(registeredRoutes().map(asKey));
    const stale = [...PUBLIC_ROUTES.map(asKey), ...GUARDED_ROUTES.map(asKey)].filter(
      (key) => !registered.has(key),
    );

    expect(stale).toEqual([]);
  });

  it("registers routes at all, so an empty router cannot pass the checks above", () => {
    // Both assertions above are satisfied by a router with nothing in it. Without this, a
    // `createApp` that silently registered nothing would look perfectly compliant.
    expect(registeredRoutes().length).toBeGreaterThanOrEqual(12);
  });

  it("agrees with the middleware about which paths are public", () => {
    // Two lists of public paths — the middleware's and the table's — would drift, and the drift
    // is invisible: a path public in the table but guarded in the middleware simply 401s, and
    // the reverse is a route nobody is checking. Pinned here rather than merged, because the
    // middleware matches a *request* path and the table names a *route pattern*.
    for (const route of PUBLIC_ROUTES) {
      expect(isPublicPath(route.examplePath)).toBe(true);
    }
    for (const route of GUARDED_ROUTES) {
      expect(isPublicPath(route.examplePath)).toBe(false);
    }
  });
});
