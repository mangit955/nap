import { computerScreenshotKey } from "@nap/shared/computer-artifacts";
import type { EventStore } from "@nap/shared/ports/event-store";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { SessionStore } from "@nap/shared/ports/session-store";
import type { Hono } from "hono";
import { z } from "zod";
import { findOwnedSession } from "../auth/owned-session.ts";
import type { AuthVariables } from "../auth/require-user.ts";

export type ComputerScreenshotDeps = {
  sessions: SessionStore;
  events: EventStore;
  objects: ObjectStore;
};
const SequenceSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export function registerComputerScreenshotRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  deps: ComputerScreenshotDeps,
): void {
  app.get("/sessions/:sessionId/computer/screenshots/:seq", async (c) => {
    const owned = await findOwnedSession(deps.sessions, c.req.param("sessionId"), c.get("userId"));
    if (!owned.ok) return c.json({ error: owned.error.message }, owned.error.status);
    const seq = SequenceSchema.safeParse(c.req.param("seq"));
    if (!seq.success) return c.json({ error: "Invalid screenshot sequence." }, 400);
    const event = (await deps.events.readFrom(owned.value.sessionId, seq.data - 1)).find(
      (event) => event.seq === seq.data,
    );
    if (event?.type !== "computer.screenshot") return c.json({ error: "No such screenshot." }, 404);
    const key = computerScreenshotKey({
      projectId: owned.value.projectId,
      sessionId: owned.value.sessionId,
      turnId: event.turnId,
      toolCallId: event.payload.toolCallId,
    });
    if (event.payload.key !== key) return c.json({ error: "No such screenshot." }, 404);
    const result = await deps.objects.get(key);
    if (!result.ok)
      return c.json(
        { error: "Screenshot is unavailable." },
        result.error.code === "not_found" ? 404 : 503,
      );
    return c.body(Uint8Array.from(result.value).buffer, 200, {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
  });
}
