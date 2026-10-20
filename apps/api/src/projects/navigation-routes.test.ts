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
