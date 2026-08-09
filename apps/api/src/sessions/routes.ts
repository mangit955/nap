/**
 * Opening a session to talk in.
 *
 * The browser has no session on first load and nothing else it can do until it has one, so
 * this is the first request the app makes. It creates the project too — a session is a
 * conversation *about* something, and there is no way to pick that something yet.
 *
 * **A placeholder for project CRUD**, and marked as one in `@nap/db`'s `session-bootstrap`:
 * no listing, no naming beyond an optional label, no ownership, because there is no sign-in
 * to own it with. What this route will keep once that arrives is its shape — a POST that
 * answers with the ids the rest of the client needs.
 *
 * Takes a function rather than a database, so the route is exercised without Postgres and the
 * rows it writes are tested where the constraints that govern them live.
 */

import type { Hono } from "hono";
import { z } from "zod";
import { getLogger } from "../logger.ts";

export type CreatedSession = { sessionId: string; projectId: string };

export type SessionRouteDeps = {
  createSession: (options: { name?: string }) => Promise<CreatedSession>;
};

/** Optional in every direction: the browser sends `{}` and means "anything". */
const CreateSessionSchema = z.object({ name: z.string().optional() });

export function registerSessionRoutes(app: Hono, deps: SessionRouteDeps): void {
  app.post("/sessions", async (c) => {
    const body = CreateSessionSchema.safeParse((await readJson(c.req.raw)) ?? {});
    if (!body.success) {
      return c.json({ error: body.error.issues.map((issue) => issue.message).join("; ") }, 400);
    }

    try {
      const created = await deps.createSession(
        body.data.name === undefined ? {} : { name: body.data.name },
      );
      return c.json(created, 201);
    } catch (error) {
      // Caught rather than left to the error handler so the log line names what failed. The
      // client is blocked on this call before it can render anything, so a bare 500 with no
      // trace of the cause is the worst possible answer.
      getLogger().error({ err: error }, "could not create a session");
      return c.json({ error: "could not create a session" }, 500);
    }
  });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
