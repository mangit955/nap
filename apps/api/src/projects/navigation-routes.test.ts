import { NavigationSchema } from "@nap/shared/session-navigation";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { AuthVariables } from "../auth/require-user.ts";
import { registerNavigationRoutes } from "./navigation-routes.ts";

it("checks origins, revisions and owner scope for every navigation write", async () => {
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const store = {
    list: vi.fn(async () => ({ sessions: [], next: null })),
    change: vi.fn(async () => ({
      kind: "saved" as const,
      navigation: NavigationSchema.parse({ pinned: true }),
      revision: 1,
    })),
    reorder: vi.fn(async () => ({ kind: "saved" as const })),
    search: vi.fn(async () => ({ results: [] })),
    autoSettleSettings: vi.fn(async () => ({ afterDays: null, onMerge: false })),
    saveAutoSettleSettings: vi.fn(async () => {}),
  };
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  registerNavigationRoutes(app, { store, webOrigin: "https://nap.example" });
  const patch = (body: unknown, origin = "https://nap.example") =>
    app.request(`/projects/${projectId}/navigation`, {
      method: "PATCH",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await patch({ change: { kind: "pin", pinned: true } })).status).toBe(400);
  const body = { revision: 0, change: { kind: "pin", pinned: true } };
  expect((await patch(body, "https://stranger.example")).status).toBe(403);
  expect((await patch(body)).status).toBe(200);
  expect(store.change).toHaveBeenCalledExactlyOnceWith(userId, projectId, body);
  expect((await app.request("/sessions?after=bad")).status).toBe(400);
  expect((await app.request("/sessions")).headers.get("cache-control")).toBe("no-store");
});

it("bounds and scopes search, and validates auto-settle settings before saving them", async () => {
  const userId = crypto.randomUUID();
  const store = {
    list: vi.fn(async () => ({ sessions: [], next: null })),
    change: vi.fn(async () => ({ kind: "missing" as const })),
    reorder: vi.fn(async () => ({ kind: "saved" as const })),
    search: vi.fn(async () => ({ results: [] })),
    autoSettleSettings: vi.fn(async () => ({ afterDays: 7, onMerge: false })),
    saveAutoSettleSettings: vi.fn(async () => {}),
  };
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  registerNavigationRoutes(app, { store, webOrigin: "https://nap.example" });

  for (const q of ["", "a", " ab ", "x".repeat(101)])
    expect((await app.request(`/sessions/search?q=${encodeURIComponent(q)}`)).status).toBe(400);
  expect((await app.request("/sessions/search")).status).toBe(400);
  const found = await app.request(`/sessions/search?q=${encodeURIComponent("  50% off ")}`);
  expect(found.status).toBe(200);
  expect(found.headers.get("cache-control")).toBe("no-store");
  expect(store.search).toHaveBeenCalledExactlyOnceWith(userId, "50% off");

  expect(await (await app.request("/sessions/auto-settle")).json()).toEqual({
    afterDays: 7,
    onMerge: false,
  });
  const put = (body: unknown, origin = "https://nap.example") =>
    app.request("/sessions/auto-settle", {
      method: "PUT",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const settings = { afterDays: 14, onMerge: true };
  expect((await put(settings, "https://stranger.example")).status).toBe(403);
  for (const bad of [{ afterDays: 0, onMerge: true }, { afterDays: 366, onMerge: false }, {}])
    expect((await put(bad)).status).toBe(400);
  expect(store.saveAutoSettleSettings).not.toHaveBeenCalled();
  expect((await put(settings)).status).toBe(200);
  expect(store.saveAutoSettleSettings).toHaveBeenCalledExactlyOnceWith(userId, settings);
});
