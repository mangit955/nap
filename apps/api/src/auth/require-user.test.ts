/**
 * The gate every request passes through.
 *
 * These test the middleware in isolation, on a throwaway Hono app with two routes. Whether the
 * *real* routes are behind it is a different claim and a different file — `route-coverage.test.ts`
 * enumerates them, because a middleware that works perfectly is no help if a route is registered
 * before it.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Authenticate } from "./auth.ts";
import { type AuthVariables, isPublicPath, requireUser } from "./require-user.ts";

const signedIn: Authenticate = async () => ({ userId: "user-a" });
const signedOut: Authenticate = async () => null;

/** Two routes: one public by path, one not. Enough to see the middleware decide. */
function appWith(authenticate: Authenticate | undefined): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireUser(authenticate));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/projects", (c) => c.json({ userId: c.get("userId") }));
  return app;
}

describe("isPublicPath", () => {
  it("lets through the three paths that cannot require a session", () => {
    // Liveness is polled by things that never sign in; the auth routes are how you *get* a
    // session, so requiring one to reach them is a locked door with the key inside.
    expect(isPublicPath("/health")).toBe(true);
    expect(isPublicPath("/auth/providers")).toBe(true);
    expect(isPublicPath("/api/auth/sign-in/email")).toBe(true);
    expect(isPublicPath("/api/auth/callback/github")).toBe(true);
  });

  it("guards everything else", () => {
    expect(isPublicPath("/projects")).toBe(false);
    expect(isPublicPath("/sessions/abc/turns")).toBe(false);
    expect(isPublicPath("/ws")).toBe(false);
  });

  it("does not treat a path that merely starts with a public one as public", () => {
    // `/healthz` and `/auth/providers-admin` are different routes. A `startsWith` check on the
    // exact paths would hand both of them out unauthenticated.
    expect(isPublicPath("/healthz")).toBe(false);
    expect(isPublicPath("/auth/providers-admin")).toBe(false);
  });
});

describe("requireUser", () => {
  it("refuses an unauthenticated request with a 401", async () => {
    const response = await appWith(signedOut).request("/projects");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) });
  });

  it("passes the caller's id to the handler", async () => {
    const response = await appWith(signedIn).request("/projects");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ userId: "user-a" });
  });

  it("leaves the public paths alone whether or not anyone is signed in", async () => {
    for (const authenticate of [signedIn, signedOut, undefined]) {
      expect((await appWith(authenticate).request("/health")).status).toBe(200);
    }
  });

  it("refuses everything when the app was built with no way to authenticate", async () => {
    // The safe direction. An app wired up without authentication having *no* reach into user
    // data is recoverable; the reverse is one forgotten line in boot serving every project to
    // anyone who asks.
    expect((await appWith(undefined).request("/projects")).status).toBe(401);
  });

  it("does not answer a preflight, which would break every cross-origin call", async () => {
    // CORS is registered ahead of this and answers OPTIONS itself. If a preflight ever reached
    // here it would 401 — and a failed preflight surfaces in the browser as a CORS error, which
    // sends you looking at the wrong configuration entirely.
    const app = appWith(signedOut);
    const response = await app.request("/projects", { method: "OPTIONS" });

    expect(response.status).not.toBe(401);
  });
});
