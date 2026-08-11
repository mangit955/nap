/**
 * Every guarded route, three ways: signed out, signed in as somebody else, signed in as the owner.
 *
 * Table-driven because the interesting property is *uniformity*. Any one of these routes is easy
 * to get right on its own; what goes wrong is one of them being written later, or differently, and
 * answering 403 where the rest answer 404 — which is a leak assembled out of individually
 * reasonable decisions. Driving them all from one list means a route cannot be quietly special.
 *
 * The list itself is shared with `route-coverage.test.ts`, which proves it names every route the
 * router registered. That pairing is the actual guarantee: this file says the listed routes
 * behave, and that file says the list is complete.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { type AppDeps, createApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import {
  fullyWiredDeps,
  GUARDED_ROUTES,
  type GuardedRoute,
  OWNER,
  PUBLIC_ROUTES,
  type SeededSandbox,
  STRANGER,
  seedSandbox,
} from "./route-table.ts";

/**
 * A real (in-memory) sandbox holding one file. Without it the owner's request for a file 404s
 * because there is nothing there — indistinguishable, to this test, from being refused.
 */
let seeded: SeededSandbox;

beforeAll(async () => {
  seeded = await seedSandbox();
});

const silent = () => createLogger({ level: "silent" }, { write: () => {} });

/** `undefined` builds an app nobody is signed in to. */
function appAs(userId: string | undefined): ReturnType<typeof createApp> {
  const deps: Omit<AppDeps, "logger"> = fullyWiredDeps(seeded);
  return createApp({
    logger: silent(),
    ...deps,
    authenticate: async () => (userId === undefined ? null : { userId }),
  });
}

async function request(app: ReturnType<typeof createApp>, route: GuardedRoute): Promise<Response> {
  return await app.request(route.examplePath, {
    method: route.method,
    ...(route.body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(route.body) }),
  });
}

/** So a failure names the route rather than a row number. */
const label = (route: GuardedRoute) => `${route.method} ${route.path}`;

describe("signed out", () => {
  it.each(GUARDED_ROUTES.map((route) => [label(route), route] as const))(
    "%s is 401",
    async (_name, route) => {
      const res = await request(appAs(undefined), route);

      expect(res.status).toBe(401);
    },
  );

  it.each(PUBLIC_ROUTES.map((route) => [`${route.method} ${route.path}`, route] as const))(
    "%s is still reachable",
    async (_name, route) => {
      // The other half of the same claim. A gate that refuses everything is trivially secure and
      // useless: nobody could sign in, because signing in is itself a request.
      const res = await appAs(undefined).request(route.examplePath);

      expect(res.status).not.toBe(401);
    },
  );
});

describe("signed in as somebody else", () => {
  /**
   * The collection routes are not addressed by an id, so there is nothing of anyone else's to
   * ask for — `GET /projects` returns a stranger's own (empty) list, and `POST /projects` makes
   * them one. Their scoping is proven by the store tests, and by the listing assertion below.
   */
  const addressed = GUARDED_ROUTES.filter(
    (route) => route.path.includes(":") || route.path === "/ws",
  );

  it.each(addressed.map((route) => [label(route), route] as const))(
    "%s is 404, not 403",
    async (_name, route) => {
      // 404 throughout: a 403 would confirm the project or session exists, which is a fact about
      // another person's data that a stranger should not be able to establish.
      const res = await request(appAs(STRANGER), route);

      expect(res.status).toBe(404);
    },
  );

  it("sees none of the owner's projects in their listing", async () => {
    const res = await appAs(STRANGER).request("/projects");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ projects: [] });
  });
});

describe("signed in as the owner", () => {
  it.each(GUARDED_ROUTES.map((route) => [label(route), route] as const))(
    "%s is neither refused nor missing",
    async (_name, route) => {
      // Deliberately not asserting a specific success code. These routes answer 200, 201, 202 and
      // 409 depending on what they do and on the fixture's state, and pinning each one here would
      // make this a second copy of the route tests. What matters is that the *gate* let them
      // through: anything but 401 and 404 means authorization was not the thing that stopped it.
      const res = await request(appAs(OWNER), route);

      expect([res.status, label(route)]).not.toEqual([401, label(route)]);
      expect([res.status, label(route)]).not.toEqual([404, label(route)]);
    },
  );
});
