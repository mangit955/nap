/**
 * Starting and stopping a turn.
 *
 * **The turn runs detached and the request answers immediately.** A turn is a minute or two
 * of model calls and sandbox commands; the client is already subscribed to the session's
 * event stream and sees `user.message` land within milliseconds of this returning, so holding
 * the connection open for the duration would buy nothing and lose to the first proxy with an
 * idle timeout. What the caller gets back is "accepted", not "done".
 *
 * That makes two things load-bearing. The background promise **must** be handled — an
 * unhandled rejection ends the Bun process, which would turn one broken turn into an outage
 * for every open tab. And the turn has to be findable again to be cancelled, which is what
 * `TurnRegistry` is for.
 *
 * A session that does not exist is refused here as well as inside the runtime. The runtime's
 * answer is a failed turn with no event — correctly, since an event needs a session to belong
 * to — and a client waiting on a socket would simply never hear anything.
 */

import type { Runtime } from "@nap/shared/ports/runtime";
import type { SessionStore } from "@nap/shared/ports/session-store";
import type { Hono } from "hono";
import { z } from "zod";
import { findOwnedSession } from "../auth/owned-session.ts";
import type { AuthVariables } from "../auth/require-user.ts";
import { getLogger } from "../logger.ts";
import type { TurnRegistry } from "./registry.ts";

export type TurnRouteDeps = {
  runtime: Runtime;
  registry: TurnRegistry;
  /** Only to reject an unknown session before starting anything. */
  sessions: SessionStore;
};

const TurnBodySchema = z.object({
  /** Trimmed before the check: a message of spaces is an accident, not a prompt. */
  message: z
    .string()
    .transform((text) => text.trim())
    .refine((text) => text.length > 0, { message: "message must not be empty" }),
});

export function registerTurnRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  deps: TurnRouteDeps,
): void {
  app.post("/sessions/:sessionId/turns", async (c) => {
    const found = await findOwnedSession(deps.sessions, c.req.param("sessionId"), c.get("userId"));
    if (!found.ok) return c.json({ error: found.error.message }, found.error.status);

    const body = TurnBodySchema.safeParse(await readJson(c.req.raw));
    if (!body.success) {
      return c.json({ error: body.error.issues.map((issue) => issue.message).join("; ") }, 400);
    }

    const { sessionId } = found.value;
    const signal = deps.registry.start(sessionId);
    const logger = getLogger();

    // Deliberately not awaited — see the note above. Both settlement paths are handled, and
    // the entry is cleared either way, or a cancel arriving later would abort a turn that
    // has already ended and the next turn would inherit an aborted signal.
    void deps.runtime
      .runTurn({ sessionId, message: body.data.message, signal })
      .then((outcome) => {
        logger.info({ outcome }, "turn settled");
      })
      .catch((error: unknown) => {
        // A thrown error is a bug in the runtime rather than a failed turn, which is a value.
        // Nothing here can recover it; what matters is that it is written down and contained.
        logger.error({ err: error }, "turn threw");
      })
      .finally(() => {
        deps.registry.finish(sessionId, signal);
      });

    return c.json({ accepted: true }, 202);
  });

  app.post("/sessions/:sessionId/turns/cancel", async (c) => {
    // Authorized before the registry is touched: cancelling somebody else's turn is exactly
    // as damaging as starting one, and a 409 for "nothing is running" would otherwise tell a
    // stranger whether a session they cannot see is busy.
    const found = await findOwnedSession(deps.sessions, c.req.param("sessionId"), c.get("userId"));
    if (!found.ok) return c.json({ error: found.error.message }, found.error.status);
    const { sessionId } = found.value;

    // Nothing running is a race, not a failure: the user clicked as the turn was ending. The
    // status says so rather than reporting a server error for something nobody did wrong.
    if (!deps.registry.cancel(sessionId)) {
      return c.json({ error: "no turn is running for this session" }, 409);
    }

    return c.json({ cancelled: true }, 202);
  });
}

/** An unparseable body is a 400 like any other bad input, not a 500. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
