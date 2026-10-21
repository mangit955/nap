import type { SessionNavigationStore } from "@nap/shared/ports/session-navigation-store";
import { NavigationChangeSchema, SessionReorderSchema } from "@nap/shared/session-navigation";
import type { Hono } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../auth/require-user.ts";

export function registerNavigationRoutes(
  router: Hono<{ Variables: AuthVariables }>,
  deps: {
    store: SessionNavigationStore;
    webOrigin: string;
  },
): void {
  router.get("/sessions", async (c) => {
    const after = z.uuid().optional().safeParse(c.req.query("after"));
    if (!after.success) return c.json({ error: "Invalid session cursor." }, 400);
    c.header("cache-control", "no-store");
    return c.json(await deps.store.list(c.get("userId"), after.data));
  });
  router.patch("/projects/:projectId/navigation", async (c) => {
    if (c.req.header("origin") !== deps.webOrigin)
      return c.json({ error: "Untrusted request origin." }, 403);
    const id = z.uuid().safeParse(c.req.param("projectId"));
    const input = NavigationChangeSchema.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !input.success) return c.json({ error: "Invalid session action." }, 400);
    if (
      input.data.change.kind === "snooze" &&
      input.data.change.until !== null &&
      (Date.parse(input.data.change.until) <= Date.now() ||
        Date.parse(input.data.change.until) > Date.now() + 365 * 86400_000)
    )
      return c.json({ error: "Choose a wake time within the next year." }, 400);
    if (
      input.data.change.kind === "read" &&
      input.data.change.at &&
      Date.parse(input.data.change.at) > Date.now() + 5000
    )
      return c.json({ error: "The read watermark is ahead of current activity." }, 400);
    const result = await deps.store.change(c.get("userId"), id.data, input.data);
    if (result.kind === "missing") return c.json({ error: "No such session." }, 404);
    if (result.kind === "conflict")
      return c.json(
        { error: "This session changed in another tab. The list has been refreshed; try again." },
        409,
      );
    if (result.kind === "busy")
      return c.json({ error: "Wait for active work to finish before parking this session." }, 409);
    return c.json({ navigation: result.navigation, revision: result.revision });
  });
  router.post("/sessions/order", async (c) => {
    if (c.req.header("origin") !== deps.webOrigin)
      return c.json({ error: "Untrusted request origin." }, 403);
    const input = SessionReorderSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Invalid session order." }, 400);
    const result = await deps.store.reorder(c.get("userId"), input.data);
    if (result.kind === "missing")
      return c.json({ error: "A session is no longer available." }, 404);
    if (result.kind === "conflict")
      return c.json(
        { error: "These sessions changed. The list has been refreshed; try the move again." },
        409,
      );
    return c.json({ saved: true });
  });
}
