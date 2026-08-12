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

import { getLogger } from "@nap/shared/logging";
import type { ProjectStore } from "@nap/shared/ports/project-store";
import type { Runtime } from "@nap/shared/ports/runtime";
import type { SessionRecord, SessionStore } from "@nap/shared/ports/session-store";
import { isUnnamed, titleFromPrompt } from "@nap/shared/project-title";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { findOwnedSession } from "../auth/owned-session.ts";
import type { AuthVariables } from "../auth/require-user.ts";
import type { TurnRateLimiter } from "./rate-limiter.ts";
import type { TurnRegistry } from "./registry.ts";
import { checkSandboxQuota, type SandboxLimits } from "./sandbox-quota.ts";

export type TurnRouteDeps = {
  runtime: Runtime;
  registry: TurnRegistry;
  /**
   * The projects these sessions belong to, so a project still carrying the default name can be
   * named after the first thing it was asked for.
   *
   * Required rather than tucked inside `limits`, where a `ProjectStore` already lives: that bag
   * is optional and absent in most route tests, and a namer that only ran when quotas were
   * configured would be a feature that works in production and nowhere else.
   */
  projects: ProjectStore;
  /** Only to reject an unknown session before starting anything. */
  sessions: SessionStore;
  /**
   * What one person may spend. Optional so the many route tests that are about status codes do
   * not each have to configure a limiter — but when it is absent nothing is limited, so boot
   * always passes one. That asymmetry is deliberate and the opposite of `authenticate`'s:
   * refusing every turn because a limiter was not wired up would be a worse default than
   * running unlimited in a test.
   */
  /** Every model a turn may name. The route refuses anything else. */
  allowedModels: readonly string[];
  limits?: {
    rate: TurnRateLimiter;
    /** Counting live sandboxes; the same store the project routes use. */
    projects: ProjectStore;
    sandboxes: SandboxLimits;
  };
};

const TurnBodySchema = z.object({
  /** Trimmed before the check: a message of spaces is an accident, not a prompt. */
  message: z
    .string()
    .transform((text) => text.trim())
    .refine((text) => text.length > 0, { message: "message must not be empty" }),
  /**
   * Which model to run on. Absent is the deployment's default, which is the normal case.
   *
   * Checked against the allowlist below rather than passed through: an unchecked model id from
   * a request body is a stranger choosing what each of your turns costs, and the expensive
   * models are the ones they would choose.
   */
  model: z.string().min(1).optional(),
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

    // Before the ceilings, because an unknown model is a malformed request rather than a
    // limit: refusing it must not consume the asker's rate-limit allowance.
    const model = body.data.model;
    if (model !== undefined && !deps.allowedModels.includes(model)) {
      return c.json(
        {
          error: `model must be one of: ${deps.allowedModels.join(", ")}`,
          code: "model_not_allowed",
        },
        400,
      );
    }

    // Both ceilings are checked after the body, so a malformed request never costs somebody a
    // slot, and before the registry, so a refused turn leaves no trace of having been started.
    const refusal = await refuse(deps, found.value, c.get("userId"));
    if (refusal !== undefined) return refusal(c);

    const { sessionId } = found.value;
    const signal = deps.registry.start(sessionId);
    const logger = getLogger();

    // Awaited rather than detached: it is one indexed update, and the client reloads the project
    // record as soon as the turn is accepted — naming it in the background would race that read
    // and leave the bar saying "Untitled project" until something else refreshed it.
    await nameFromFirstPrompt(deps, found.value, c.get("userId"), body.data.message);

    // Deliberately not awaited — see the note above. Both settlement paths are handled, and
    // the entry is cleared either way, or a cancel arriving later would abort a turn that
    // has already ended and the next turn would inherit an aborted signal.
    void deps.runtime
      .runTurn({
        sessionId,
        message: body.data.message,
        signal,
        ...(model === undefined ? {} : { model }),
      })
      .then((outcome) => {
        // `turnId` hoisted out of the outcome rather than left nested inside it: this line is
        // written by the request, which never learns the id the runtime generated, so without
        // it the one line saying how the turn ended is not reachable by the key everything
        // else about that turn is grouped under.
        logger.info({ turnId: outcome.turnId, outcome }, "turn settled");
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

/**
 * Whether this turn is refused, and how to say so.
 *
 * Returns a function rather than a response so the two statuses stay next to their reasons.
 * They are different on purpose: **429 for the rate limit**, which is a speed problem and comes
 * with a `Retry-After` a client can obey, and **409 for the quota**, which is a conflict with
 * the current state and is fixed by closing a project rather than by waiting. Both carry a
 * `code`, so the browser can tell them apart without reading the prose.
 */
async function refuse(
  deps: TurnRouteDeps,
  session: SessionRecord,
  userId: string,
): Promise<((c: Context) => Response) | undefined> {
  const { limits } = deps;
  if (limits === undefined) return undefined;

  const rate = limits.rate.check(userId, Date.now());
  if (!rate.allowed) {
    const seconds = rate.retryAfterSeconds;
    return (c) =>
      c.json(
        {
          error: `Too many turns. Try again in ${describeWait(seconds)}.`,
          code: "rate_limited",
        },
        429,
        // The header, not just the body: this is the one a client library or a proxy honours
        // on its own, and a 429 without it invites an immediate retry.
        { "retry-after": String(seconds) },
      );
  }

  const quota = await checkSandboxQuota({
    projects: limits.projects,
    userId,
    sessionSandboxId: session.sandboxId,
    limits: limits.sandboxes,
  });
  if (!quota.allowed) {
    return (c) => c.json({ error: quota.message, code: "sandbox_quota_exceeded" }, 409);
  }

  return undefined;
}

/** Seconds are what the header carries; a person reads minutes. */
function describeWait(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** An unparseable body is a 400 like any other bad input, not a 500. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/**
 * Names a project after the first thing somebody asked it for.
 *
 * **Here, on the first turn, rather than when the project is created**, because that is the one
 * hook every path goes through. The landing page and the dashboard composer both create a project
 * and *then* send a prompt; the dashboard's "New project" button creates one with no prompt at
 * all and the first message arrives minutes later. Naming at creation time would miss the third
 * and would make the browser responsible for knowing how names are derived.
 *
 * It fires only while the name is still the default, which makes it idempotent and means a
 * project somebody has renamed themselves is never overwritten.
 *
 * **A failure here is swallowed.** A name is a convenience; costing somebody their turn because
 * an UPDATE failed would trade the whole feature for a cosmetic one.
 */
async function nameFromFirstPrompt(
  deps: TurnRouteDeps,
  session: SessionRecord,
  userId: string,
  message: string,
): Promise<void> {
  try {
    const project = await deps.projects.get(session.projectId, userId);
    if (project === null || !isUnnamed(project.name)) return;

    await deps.projects.rename(session.projectId, userId, titleFromPrompt(message));
  } catch (error) {
    getLogger().warn({ err: error, projectId: session.projectId }, "could not name the project");
  }
}
