/**
 * A sign-in check that cannot reach the database must say so in the log, and must not write the
 * caller's session token there.
 *
 * Production did exactly that during a database restart (#283): the session lookup failed,
 * Drizzle's error carried the query's parameters — the bearer token — in its message and in an
 * enumerable `params` field, and Better Auth printed the whole error to `console`. Both writers
 * are captured here. pino gets Better Auth's own lines, through the bridge in
 * `better-auth-log.ts`, and the app's `unhandled error` line for the request's 500 (which holds
 * only Better Auth's "Failed to get session"). `console` gets whatever a library prints there
 * directly, as better-call's router does for a failure no route caught; boot routes `console`
 * through `redactConsole`, and so does this file.
 *
 * No database is needed to make the lookup fail: the auth instance is pointed at a port nothing
 * listens on, so every query is refused exactly as it was during the restart. The cookie is
 * signed here with the same HMAC Better Auth uses, so the library gets as far as the query.
 */

import { createHmac } from "node:crypto";
import { format } from "node:util";
import { createDatabase } from "@nap/db/client";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { redactConsole } from "../redact-query-params.ts";
import { createAuth } from "./auth.ts";

const SECRET = "a-test-secret-that-is-long-enough-to-be-a-secret";
const API_ORIGIN = "http://localhost:3001";
const WEB_ORIGIN = "http://localhost:3000";
const TOKEN = `tok-${crypto.randomUUID()}`;

/** Better Auth's signed cookie: `token.base64(hmac-sha256(secret, token))`, URI-encoded. */
function sessionCookie(token: string): string {
  const signature = createHmac("sha256", SECRET).update(token).digest("base64");
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

// Port 1 is reserved and nothing listens on it, so the connection is refused at once.
const unreachable = createDatabase("postgres://nap:nap@127.0.0.1:1/nap", { max: 1 });

const pinoLines: string[] = [];
const consoleLines: string[] = [];

const auth = createAuth(unreachable.db, {
  secret: SECRET,
  baseUrl: API_ORIGIN,
  webOrigin: WEB_ORIGIN,
  github: { clientId: "test-client-id", clientSecret: "test-client-secret" },
  allowAnonymous: true,
});

const app = createApp({
  logger: createLogger({ level: "debug" }, { write: (line: string) => pinoLines.push(line) }),
  auth,
  authenticate: auth.getUser,
  stream: {
    store: new InMemoryEventStore(),
    bus: new InMemoryEventBus(),
    upgradeWebSocket: () => Promise.resolve(new Response(null)),
  },
});

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;
const originalConsole = Object.fromEntries(CONSOLE_METHODS.map((m) => [m, console[m]]));

beforeEach(() => {
  pinoLines.length = 0;
  consoleLines.length = 0;
  for (const m of CONSOLE_METHODS) {
    console[m] = (...args: unknown[]) => consoleLines.push(format(...args));
  }
  redactConsole();
});

afterEach(() => {
  for (const m of CONSOLE_METHODS) console[m] = originalConsole[m] as Console[typeof m];
});

afterAll(async () => {
  await unreachable.close();
});

/** Everything either writer produced, as one string to search. */
function everythingLogged(): string {
  return [...pinoLines, ...consoleLines].join("\n");
}

describe("a session lookup against an unreachable database", () => {
  it.each([
    ["an authenticated API request", "/projects"],
    ["Better Auth's own session endpoint", "/api/auth/get-session"],
  ])("via %s logs the failure without the token", async (_name, path) => {
    const response = await app.request(`${API_ORIGIN}${path}`, {
      headers: { cookie: sessionCookie(TOKEN) },
    });

    expect(response.status).toBe(500);

    const logged = everythingLogged();
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("params:");

    // Still useful to whoever reads it: the failed query is named, and so is why it failed.
    const errors = pinoLines.filter((line) => (JSON.parse(line) as { level: number }).level >= 50);
    expect(errors.join("\n")).toContain("auth_sessions");
    expect(errors.join("\n")).toContain("ECONNREFUSED");
  });

  it("sends Better Auth's lines through the app's logger, not console", async () => {
    await app.request(`${API_ORIGIN}/api/auth/get-session`, {
      headers: { cookie: sessionCookie(TOKEN) },
    });
    expect(consoleLines).toEqual([]);
    expect(pinoLines.some((line) => line.includes("Better Auth"))).toBe(true);
  });

  it.each([
    ["an email sign-in", "/api/auth/sign-in/email", { password: "a-long-enough-password" }],
    [
      "an email sign-up",
      "/api/auth/sign-up/email",
      { password: "a-long-enough-password", name: "N" },
    ],
    ["a GitHub sign-in", "/api/auth/sign-in/social", { provider: "github", callbackURL: "/" }],
  ])("via %s, which no route catches, writes no parameter anywhere", async (_name, path, body) => {
    const email = `victim-${crypto.randomUUID()}@example.com`;

    const response = await app.request(`${API_ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify({ email, ...body }),
    });

    expect(response.status).toBe(500);
    const logged = everythingLogged();
    // The router's own line is the path under test: it reached console, and was redacted there.
    expect(consoleLines.join("\n")).toContain("SERVER_ERROR");
    expect(logged).toContain("Failed query:");
    expect(logged).not.toContain(email);
    expect(logged).not.toContain("params:");
    expect(logged).not.toContain("codeVerifier");
  });
});
