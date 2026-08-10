import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { VERSION } from "@nap/shared/version";
import type { WSEvents } from "hono/ws";
import { describe, expect, it } from "vitest";
import { type AppDeps, createApp } from "./app.ts";
import { createLogger } from "./logger.ts";

/**
 * `app.request()` dispatches straight into the router, so nothing here opens a socket — the
 * unit suite stays free of the network. What a real socket adds is covered by
 * `bun run ws:smoke`, which needs Bun; booting a real listener is what `bun run dev` is for.
 */

const silent = () => createLogger({ level: "silent" }, { write: () => {} });

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";

/** Records what the route asked to upgrade, standing in for Bun's real one. */
class FakeUpgrader {
  readonly calls: WSEvents[] = [];

  readonly upgrade = async (_c: unknown, events: WSEvents): Promise<Response> => {
    this.calls.push(events);
    // What hono/bun returns once `server.upgrade` succeeds. Not a 101: the runtime has
    // already answered the handshake by then, and `new Response(null, { status: 101 })`
    // is not even constructible outside Bun.
    return new Response(null);
  };
}

function app(overrides: Partial<AppDeps> = {}) {
  return createApp({
    logger: silent(),
    stream: {
      store: new InMemoryEventStore(),
      bus: new InMemoryEventBus(),
      upgradeWebSocket: new FakeUpgrader().upgrade,
    },
    ...overrides,
  });
}

describe("GET /health", () => {
  it("returns 200 with a version field", async () => {
    const res = await app().request("/health");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok", version: VERSION });
  });

  it("reports the version the workspace actually ships", async () => {
    // Guards against the endpoint hardcoding a string that drifts from the package.
    const res = await app().request("/health");
    const body = (await res.json()) as { version: string };
    expect(body.version).toBe(VERSION);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("responds as JSON", async () => {
    const res = await app().request("/health");
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("GET /ws", () => {
  it("upgrades a request with a valid session and seq", async () => {
    const upgrader = new FakeUpgrader();
    const res = await app({
      stream: {
        store: new InMemoryEventStore(),
        bus: new InMemoryEventBus(),
        upgradeWebSocket: upgrader.upgrade,
      },
    }).request(`/ws?sessionId=${SESSION}&seq=3`);

    expect(res.status).toBe(200);
    expect(upgrader.calls).toHaveLength(1);
    // The four handlers Bun dispatches into. A missing onClose is a leaked subscription.
    expect(Object.keys(upgrader.calls[0] ?? {}).sort()).toEqual([
      "onClose",
      "onError",
      "onMessage",
      "onOpen",
    ]);
  });

  it.each([
    ["no session id", "/ws"],
    ["a session id that is not a uuid", "/ws?sessionId=nope"],
    ["an unusable seq", `/ws?sessionId=${SESSION}&seq=-4`],
  ])("refuses %s with a 400 and never upgrades", async (_name, path) => {
    // Refused before the upgrade, so the reason travels in a body a client can read — a
    // socket that opens and closes immediately says nothing at all.
    const upgrader = new FakeUpgrader();
    const res = await app({
      stream: {
        store: new InMemoryEventStore(),
        bus: new InMemoryEventBus(),
        upgradeWebSocket: upgrader.upgrade,
      },
    }).request(path);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
    expect(upgrader.calls).toEqual([]);
  });
});

describe("unknown routes", () => {
  it("404 as JSON rather than an HTML error page", async () => {
    // Every client of this API speaks JSON; an HTML body on the error path is what turns a
    // typo'd URL into an unreadable parse failure in the browser.
    const res = await app().request("/nope");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
  });
});

describe("CORS", () => {
  const WEB = "http://localhost:3000";

  it("lets the configured origin through with credentials", async () => {
    // Both headers or neither is useful: a browser will not attach a session cookie to a
    // cross-origin request unless the response names the origin *and* allows credentials,
    // and it refuses the combination of credentials with a `*` origin outright.
    const res = await app({ webOrigin: WEB }).request("/health", {
      headers: { origin: WEB },
    });

    expect(res.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("answers a preflight before the request reaches a route", async () => {
    // The browser sends this on its own for anything with a JSON body, and it is sent to the
    // real path — so a preflight that fell through to the router would 404 and the actual
    // request would never be made.
    const res = await app({ webOrigin: WEB }).request("/projects", {
      method: "OPTIONS",
      headers: {
        origin: WEB,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBe(WEB);
  });

  it("sends no CORS headers at all when no origin is configured", async () => {
    // Same-origin deployments need none of this, and a header saying "anyone" would be worse
    // than the header being absent.
    const res = await app().request("/health", { headers: { origin: WEB } });

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("request logging", () => {
  it("logs each request with a request id available to downstream code", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info" }, { write: (m) => lines.push(m) });

    await app({ logger }).request("/health");

    const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]).toMatchObject({ method: "GET", path: "/health" });
  });

  it("logs a stream request under the session it is for", async () => {
    // The middleware picks sessionId out of the query, so everything a connection logs is
    // attributable without every call site being handed the id.
    const lines: string[] = [];
    const logger = createLogger({ level: "info" }, { write: (m) => lines.push(m) });

    await app({ logger }).request(`/ws?sessionId=${SESSION}`);

    const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records[0]).toMatchObject({ path: "/ws", sessionId: SESSION });
  });
});
