import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import type { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { createLogger } from "../logger.ts";

const silent = () => createLogger({ level: "silent" }, { write: () => {} });

const CREATED = {
  sessionId: "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f",
  projectId: "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192",
};

function app(createSession = vi.fn().mockResolvedValue(CREATED)): {
  app: Hono;
  createSession: ReturnType<typeof vi.fn>;
} {
  return {
    app: createApp({
      logger: silent(),
      stream: {
        store: new InMemoryEventStore(),
        bus: new InMemoryEventBus(),
        upgradeWebSocket: async () => new Response(null),
      },
      sessions: { createSession },
    }),
    createSession,
  };
}

const post = (hono: Hono, body?: unknown) =>
  hono.request("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("POST /sessions", () => {
  it("creates a session and returns its ids", async () => {
    const { app: hono } = app();

    const res = await post(hono);

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual(CREATED);
  });

  it("works with no body at all", async () => {
    // What the browser sends on first load: it has nothing to say beyond "I need a session".
    const { app: hono, createSession } = app();

    expect((await post(hono)).status).toBe(201);
    expect(createSession).toHaveBeenCalledWith({});
  });

  it("passes a name through when one is given", async () => {
    const { app: hono, createSession } = app();

    await post(hono, { name: "Todo app" });

    expect(createSession).toHaveBeenCalledWith({ name: "Todo app" });
  });

  it("400s for a name that is not a string", async () => {
    const { app: hono, createSession } = app();

    expect((await post(hono, { name: 42 })).status).toBe(400);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("reports a failure as JSON rather than an HTML error page", async () => {
    // The database being down is the realistic case, and the browser blocks on this call
    // before it can render anything at all.
    const { app: hono } = app(vi.fn().mockRejectedValue(new Error("connection refused")));

    const res = await post(hono);

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("when the app is built without session creation", () => {
  it("has no session route", async () => {
    const unwired = createApp({
      logger: silent(),
      stream: {
        store: new InMemoryEventStore(),
        bus: new InMemoryEventBus(),
        upgradeWebSocket: async () => new Response(null),
      },
    });

    expect((await post(unwired)).status).toBe(404);
  });
});
