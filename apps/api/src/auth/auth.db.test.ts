/**
 * The three claims `docs/PLAN.md` §4 makes about authentication, against a real Postgres:
 * a signup/login/logout round trip, an expired session refused, and a repeat OAuth login
 * finding the same person rather than making a second one.
 *
 * Real, because two of the three are the database's answer rather than this code's: whether a
 * repeat login finds the same person is `unique(provider_id, account_id)` doing its job, and
 * whether an old session is refused is a comparison against a column. A fake would agree with
 * itself about both.
 *
 * The container is shared across the `db` project, so nothing here may assume an empty table.
 * Every user gets a unique email and every assertion is scoped to it.
 */

import { createDatabase } from "@nap/db/client";
import { accounts, authSessions, users } from "@nap/db/schema";
// Type-only, and deliberately empty: it brings in the module augmentation that types
// `inject("postgresUrl")`. That declaration lives beside the `globalSetup` that provides the
// value, and this app's tsconfig covers only its own `src`, so without this the call is
// `inject(never)`. A value import would pull the testcontainers module in at load time.
import type {} from "@nap/db/testing/global-setup";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { createAuth } from "./auth.ts";

const API_ORIGIN = "http://localhost:3001";
const WEB_ORIGIN = "http://localhost:3000";

/** The GitHub account every OAuth test signs in as. Fixed, so "the same person" is unambiguous. */
const GITHUB_ACCOUNT_ID = "4815162342";
const GITHUB_EMAIL = "octocat@example.com";

let db: ReturnType<typeof createDatabase>;
let app: ReturnType<typeof createApp>;

const realFetch = globalThis.fetch;

beforeAll(() => {
  db = createDatabase(inject("postgresUrl"), { max: 4 });
  app = createApp({
    logger: createLogger({ level: "silent" }, { write: () => {} }),
    webOrigin: WEB_ORIGIN,
    auth: createAuth(db.db, {
      secret: "a-test-secret-that-is-long-enough-to-be-a-secret",
      baseUrl: API_ORIGIN,
      webOrigin: WEB_ORIGIN,
      github: { clientId: "test-client-id", clientSecret: "test-client-secret" },
    }),
    // Required by `createApp` and irrelevant here; nothing in this file opens a socket.
    stream: {
      store: new InMemoryEventStore(),
      bus: new InMemoryEventBus(),
      upgradeWebSocket: () => Promise.resolve(new Response(null)),
    },
  });
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A fresh address per test, so a shared container cannot make one test depend on another. */
function anEmail(): string {
  return `m5-1-${crypto.randomUUID()}@example.com`;
}

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return await app.request(`${API_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: WEB_ORIGIN,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

/**
 * The cookie header a browser would send back, rebuilt from what the response set.
 *
 * Only the `name=value` part: the attributes are instructions to the browser, and sending
 * `HttpOnly` back to the server is not something a browser ever does.
 */
function cookieFrom(response: Response): string {
  const header = response.headers.getSetCookie().join(", ");
  const pairs = header
    .split(/,\s*(?=[^;=]+=)/)
    .map((one) => one.split(";")[0]?.trim())
    .filter((one): one is string => one !== undefined && one !== "");

  if (pairs.length === 0) throw new Error(`no cookie was set: ${header || "(no header)"}`);
  return pairs.join("; ");
}

/** Whoever the cookie identifies, or null when it identifies nobody. */
async function whoAmI(cookie: string): Promise<{ email: string } | null> {
  const response = await app.request(`${API_ORIGIN}/api/auth/get-session`, {
    headers: { origin: WEB_ORIGIN, cookie },
  });
  if (!response.ok) return null;

  // An unauthenticated `get-session` is a 200 with an empty body rather than a 401.
  const text = await response.text();
  if (text === "" || text === "null") return null;

  const body = JSON.parse(text) as { user?: { email?: string } } | null;
  return body?.user?.email === undefined ? null : { email: body.user.email };
}

describe("signup, login, logout", () => {
  it("round-trips: a signed-up user can sign in, is recognised, and stops being after sign-out", async () => {
    const email = anEmail();
    const password = "correct horse battery staple";

    const signedUp = await post("/api/auth/sign-up/email", { email, password, name: "Ada" });
    expect(signedUp.status).toBe(200);

    const signedIn = await post("/api/auth/sign-in/email", { email, password });
    expect(signedIn.status).toBe(200);

    const cookie = cookieFrom(signedIn);
    expect(await whoAmI(cookie)).toEqual({ email });
    expect(await sessionRowFor(cookie)).toBeDefined();

    const signedOut = await post("/api/auth/sign-out", {}, cookie);
    expect(signedOut.status).toBe(200);

    // Both halves. A sign-out that answered 200 and left the row behind would still let the
    // cookie work on a server that had not seen this response — the row is the session.
    expect(await whoAmI(cookie)).toBeNull();
    expect(await sessionRowFor(cookie)).toBeUndefined();
  });

  it("refuses a password that is not the one that was set", async () => {
    const email = anEmail();
    await post("/api/auth/sign-up/email", { email, password: "the real password", name: "Ada" });

    const attempt = await post("/api/auth/sign-in/email", { email, password: "not that one" });

    expect(attempt.status).toBeGreaterThanOrEqual(400);
    expect(attempt.headers.getSetCookie()).toHaveLength(0);
  });
});

describe("an expired session", () => {
  it("is rejected once its row has passed its expiry", async () => {
    const email = anEmail();
    const password = "correct horse battery staple";
    await post("/api/auth/sign-up/email", { email, password, name: "Grace" });

    const signedIn = await post("/api/auth/sign-in/email", { email, password });
    const cookie = cookieFrom(signedIn);
    expect(await whoAmI(cookie)).toEqual({ email });

    // Aged through the column rather than through fake timers, so what is under test is the
    // comparison the database is asked to make — the same one a session left overnight meets.
    const session = await sessionRowFor(cookie);
    if (session === undefined) throw new Error("the sign-in recorded no session");
    await db.db
      .update(authSessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(authSessions.id, session.id));

    expect(await whoAmI(cookie)).toBeNull();
  });
});

describe("the GitHub callback", () => {
  it("creates exactly one user when the same account signs in twice", async () => {
    stubGithub();

    const first = await signInWithGithub();
    const second = await signInWithGithub();

    // Two real sign-ins: without this the test could pass by the second one failing outright.
    expect(await whoAmI(first)).toEqual({ email: GITHUB_EMAIL });
    expect(await whoAmI(second)).toEqual({ email: GITHUB_EMAIL });

    const people = await db.db.select().from(users).where(eq(users.email, GITHUB_EMAIL));
    expect(people).toHaveLength(1);

    const linked = await db.db
      .select()
      .from(accounts)
      .where(
        and(eq(accounts.providerId, "github"), eq(accounts.accountId, String(GITHUB_ACCOUNT_ID))),
      );
    expect(linked).toHaveLength(1);
    expect(linked[0]?.userId).toBe(people[0]?.id);

    // The person is one; the sign-ins are two. Collapsing those would mean the second login
    // silently reused the first one's session rather than making its own.
    expect(await sessionRowsFor(GITHUB_EMAIL)).toHaveLength(2);
  });
});

async function sessionRowsFor(email: string): Promise<{ id: string }[]> {
  return db.db
    .select({ id: authSessions.id })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .where(eq(users.email, email));
}

/**
 * The session row a particular cookie names.
 *
 * By token rather than "the newest row for this user", because **signing up already signs you
 * in**: a sign-up followed by a sign-in leaves two live sessions, and the first version of
 * these tests picked whichever came back first. It expired the wrong row and asserted that
 * sign-out had left one behind — two failures that were the fixture's fault, not the code's.
 */
async function sessionRowFor(cookie: string): Promise<{ id: string } | undefined> {
  const value = cookie
    .split("; ")
    .find((pair) => pair.startsWith("better-auth.session_token="))
    ?.slice("better-auth.session_token=".length);
  if (value === undefined) throw new Error(`no session cookie among: ${cookie}`);

  // The cookie is `<token>.<signature>`; only the token half is stored.
  const [token] = decodeURIComponent(value).split(".");
  if (token === undefined) throw new Error("the session cookie carried no token");

  const [row] = await db.db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(eq(authSessions.token, token));
  return row;
}

/**
 * Stands in for github.com for the two calls the provider makes: exchanging the code for a
 * token, and asking who the token belongs to.
 *
 * Matched by hostname and *nothing else is answered* — an unexpected request throws rather
 * than returning a plausible empty body, because a stub that shrugs turns a broken flow into
 * a passing test.
 */
function stubGithub(): void {
  globalThis.fetch = (async (input: Request | string | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
      return Response.json({
        access_token: "gho_test_token",
        token_type: "bearer",
        scope: "user:email",
      });
    }

    if (url.hostname === "api.github.com" && url.pathname === "/user") {
      return Response.json({
        id: GITHUB_ACCOUNT_ID,
        login: "octocat",
        name: "The Octocat",
        email: GITHUB_EMAIL,
        avatar_url: "https://example.com/octocat.png",
      });
    }

    if (url.hostname === "api.github.com" && url.pathname === "/user/emails") {
      return Response.json([{ email: GITHUB_EMAIL, primary: true, verified: true }]);
    }

    throw new Error(`the GitHub stub was asked for something it does not serve: ${url.href}`);
  }) as typeof fetch;
}

/**
 * One whole OAuth round trip: ask for the authorize URL, then come back to the callback with
 * the `state` the server put in it, exactly as GitHub's redirect would.
 *
 * Returns the cookie the callback set. Driving the real routes rather than calling an internal
 * helper is the point — the state check, the account lookup and the user creation are all
 * things that only happen on this path.
 */
async function signInWithGithub(): Promise<string> {
  const started = await post("/api/auth/sign-in/social", {
    provider: "github",
    callbackURL: `${WEB_ORIGIN}/`,
  });
  expect(started.status).toBe(200);

  const { url } = (await started.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  if (state === null) throw new Error(`no state in the authorize URL: ${url}`);

  const callback = await app.request(
    `${API_ORIGIN}/api/auth/callback/github?code=test-code&state=${state}`,
    {
      // The cookies the authorize step set — the provider's state lives in one of them.
      headers: { cookie: cookieFrom(started) },
      redirect: "manual",
    },
  );

  expect(callback.status).toBeGreaterThanOrEqual(300);
  expect(callback.status).toBeLessThan(400);
  return cookieFrom(callback);
}
