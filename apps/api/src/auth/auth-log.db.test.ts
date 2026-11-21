/**
 * The second read of a session check failing, against a real Postgres.
 *
 * `auth-log.test.ts` fails the *first* read, the session lookup. When that one succeeds and the
 * follow-up read of the user fails, Better Auth's adapter takes another path: it logs the read's
 * `where` clause — the user id — through the logger it was given, and then prints the raw
 * Drizzle error with `console.error`, which no logger option reaches. Only a database can make
 * one read succeed and the next fail, so this one runs here: a role that may read
 * `auth_sessions` and not `users`.
 *
 * Boot routes `console` through `redactConsole`, and this test does the same, so what it proves
 * is the composition production runs.
 */

import { inspect } from "node:util";
import { createDatabase } from "@nap/db/client";
import type {} from "@nap/db/testing/global-setup";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { redactConsole } from "../redact-query-params.ts";
import { createAuth } from "./auth.ts";

/**
 * What Bun's `console` prints for these arguments. Bun shows an error's non-enumerable fields,
 * where Node's `util.format` hides them — and postgres.js puts a query's values on a connection
 * error in exactly such fields. Capturing with `format` would hide the leak this looks for.
 */
function printed(...args: unknown[]): string {
  return args
    .map((arg) => (typeof arg === "string" ? arg : inspect(arg, { showHidden: true, depth: 8 })))
    .join(" ");
}

const SECRET = "a-test-secret-that-is-long-enough-to-be-a-secret";
const API_ORIGIN = "http://localhost:3001";
const WEB_ORIGIN = "http://localhost:3000";
const ROLE = `auth_log_${crypto.randomUUID().replaceAll("-", "")}`;
const ROLE_PASSWORD = crypto.randomUUID();

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;
const originalConsole = Object.fromEntries(CONSOLE_METHODS.map((m) => [m, console[m]]));

let admin: ReturnType<typeof createDatabase>;
let restricted: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  const url = inject("postgresUrl");
  admin = createDatabase(url, { max: 2 });
  // Role names are cluster-wide and the container is shared, hence the random one.
  await admin.db.execute(sql.raw(`create role ${ROLE} login password '${ROLE_PASSWORD}'`));
  await admin.db.execute(sql.raw(`grant usage on schema public to ${ROLE}`));
  await admin.db.execute(sql.raw(`grant select on auth_sessions to ${ROLE}`));
  const asRole = new URL(url);
  asRole.username = ROLE;
  asRole.password = ROLE_PASSWORD;
  restricted = createDatabase(asRole.toString(), { max: 1 });
});

afterAll(async () => {
  for (const m of CONSOLE_METHODS) console[m] = originalConsole[m] as Console[typeof m];
  await restricted.close();
  await admin.db.execute(sql.raw(`drop owned by ${ROLE}`));
  await admin.db.execute(sql.raw(`drop role ${ROLE}`));
  await admin.close();
});

describe("a session whose user cannot be read", () => {
  it("logs the failed read without the user's id or the query's parameters", async () => {
    // Signed up through an instance with full access, so the session row is real.
    const full = createAuth(admin.db, {
      secret: SECRET,
      baseUrl: API_ORIGIN,
      webOrigin: WEB_ORIGIN,
      allowAnonymous: false,
    });
    const signUp = await full.handler(
      new Request(`${API_ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: WEB_ORIGIN },
        body: JSON.stringify({
          email: `auth-log-${crypto.randomUUID()}@example.com`,
          password: "a-long-enough-password",
          name: "Auth Log",
        }),
      }),
    );
    expect(signUp.status).toBe(200);
    const { user } = (await signUp.json()) as { user: { id: string } };
    const cookie = (signUp.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const pinoLines: string[] = [];
    const consoleLines: string[] = [];
    for (const m of CONSOLE_METHODS) {
      console[m] = (...args: unknown[]) => consoleLines.push(printed(...args));
    }
    redactConsole();

    const auth = createAuth(restricted.db, {
      secret: SECRET,
      baseUrl: API_ORIGIN,
      webOrigin: WEB_ORIGIN,
      allowAnonymous: false,
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

    const response = await app.request(`${API_ORIGIN}/api/auth/get-session`, {
      headers: { cookie },
    });

    expect(response.status).toBe(500);
    const everything = [...pinoLines, ...consoleLines].join("\n");
    // The library really did print to console: this is the path under test, not a quiet one.
    expect(consoleLines.join("\n")).toContain("Failed query:");
    expect(everything).not.toContain(user.id);
    expect(everything).not.toContain("params:");
    // Still says what failed and why, in the app's own log.
    expect(pinoLines.join("\n")).toContain("permission denied for table users");
  });
});
