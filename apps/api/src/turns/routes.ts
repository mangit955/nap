/**
 * Starting and stopping a turn.
 *
 * **The request is written down, not run.** A turn is a minute or two of model calls and sandbox
 * commands; the client is already subscribed to the session's event stream and sees `user.message`
 * land shortly after this returns, so holding the connection open for the duration would buy
 * nothing and lose to the first proxy with an idle timeout. What the caller gets back is
 * "accepted", not "done".
 *
 * It used to be accepted by *starting the turn here* and letting the promise run detached, which
 * meant the work belonged to whichever pod took the HTTP request and existed only in its memory.
 * Now admission ends at `queue.enqueue`: the intent is durable before the response is written, and
 * a worker — today in this same process, tomorrow in its own deployment — claims it, leases the
 * session and runs it. Two consequences worth knowing about:
 *
 *   - **The request cannot report on the turn.** It never could usefully; now it cannot at all,
 *     and anything a caller wants to know arrives as events on the session, which is where a
 *     client is already looking.
 *   - **Cancellation is a row, not a `Map`.** `requestCancel` reaches a turn running on any pod,
 *     which the old registry could not. The registry is still consulted, as a fast path for the
 *     case where the turn happens to be running here — see `registry.ts`.
 *
 * A session that does not exist is refused here as well as inside the runtime. The runtime's
 * answer is a failed turn with no event — correctly, since an event needs a session to belong
 * to — and a client waiting on a socket would simply never hear anything.
 */

import { getLogger } from "@nap/shared/logging";
import type { ModelCredentials } from "@nap/shared/ports/llm-provider";
import type { ProjectStore } from "@nap/shared/ports/project-store";
import type { SessionRecord, SessionStore } from "@nap/shared/ports/session-store";
import type { TurnQueue } from "@nap/shared/ports/turn-queue";
import type { TurnRateLimiter } from "@nap/shared/ports/turn-rate-limit";
import { isUnnamed, titleFromPrompt } from "@nap/shared/project-title";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { findOwnedSession } from "../auth/owned-session.ts";
import type { AuthVariables } from "../auth/require-user.ts";
import { resolveTurnAccess } from "./model-access.ts";
import type { TurnRegistry } from "./registry.ts";
import { checkSandboxQuota, type SandboxLimits } from "./sandbox-quota.ts";

export type TurnRouteDeps = {
  /** Where an admitted turn goes. A worker takes it from here; this route never runs one. */
  queue: TurnQueue;
  /**
   * Which turns are running *in this process*, so a cancel that lands on the pod holding the turn
   * is felt at once rather than at the worker's next renewal. Never the durable answer.
   */
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
  /** Every model a turn may name. Which of them *this* caller may name is narrower. */
  allowedModels: readonly string[];
  /**
   * Whose account pays, and therefore which models are reachable.
   *
   * Absent means nobody has a key and every turn runs on the deployment's own account under
   * the free rules — which is what an app assembled without a key store should do, rather
   * than fail every turn for want of a table.
   */
  keys?: CallerKeys;
  /** What a turn runs on when the asker has no key. Always free; the env check proves it. */
  freeModel: string;
  /** What a turn runs on when the asker has a key and names nothing. */
  defaultModel: string;
  limits?: {
    rate: TurnRateLimiter;
    /**
     * The tighter limiter, for turns this deployment is paying for.
     *
     * A second limiter rather than a second limit on one: the window is per-user *and*
     * per-limiter, so sharing one would let somebody's paid turns eat their free allowance and
     * make "5 free turns an hour" mean something different depending on what else they did.
     */
    freeRate: TurnRateLimiter;
    /** Counting live sandboxes; the same store the project routes use. */
    projects: ProjectStore;
    sandboxes: SandboxLimits;
    /** The tighter sandbox ceiling, applied to the same turns `freeRate` is. */
    freeSandboxes: SandboxLimits;
  };
};

/**
 * Reading the caller's stored key back into something a turn can be billed to.
 *
 * A narrow function rather than the store plus the encryption key, so the turn route never
 * touches ciphertext and a test can say "this person has an Anthropic key" in one line.
 */
export type CallerKeys = (userId: string) => Promise<ModelCredentials | null>;

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

    // Whose account this turn is billed to, which is also what decides which models they may
    // name. One lookup answers both, and both are needed before anything is spent.
    const key = (await deps.keys?.(c.get("userId"))) ?? null;

    // Before the ceilings, because an unreachable model is a malformed request rather than a
    // limit: refusing it must not consume the asker's rate-limit allowance.
    const access = resolveTurnAccess({
      requested: body.data.model,
      key,
      allowed: deps.allowedModels,
      freeModel: deps.freeModel,
      defaultModel: deps.defaultModel,
    });
    if (!access.ok) {
      // 403 for `byok_required` and 400 for the rest: naming a model you are not allowed to
      // *pay for* is a permission answer with something to do about it, while naming one that
      // does not exist here is a bad request with nothing a key would fix. The browser reads
      // the code and offers the key form on the first but not the second.
      return c.json(
        { error: access.message, code: access.code },
        access.code === "byok_required" ? 403 : 400,
      );
    }

    // Both ceilings are checked after the body, so a malformed request never costs somebody a
    // slot, and before the registry, so a refused turn leaves no trace of having been started.
    // Which ceilings apply depends on who is paying — see `refuse`.
    const refusal = await refuse(deps, found.value, c.get("userId"), key !== null);
    if (refusal !== undefined) return refusal(c);

    const { sessionId } = found.value;

    // Awaited rather than detached: it is one indexed update, and the client reloads the project
    // record as soon as the turn is accepted — naming it in the background would race that read
    // and leave the bar saying "Untitled project" until something else refreshed it.
    await nameFromFirstPrompt(deps, found.value, c.get("userId"), body.data.message);

    // Where admission ends. Durable before the response is written, so a pod that dies in the next
    // millisecond costs the turn a delay rather than the turn itself.
    const { id } = await deps.queue.enqueue({
      sessionId,
      userId: c.get("userId"),
      kind: "turn",
      message: body.data.message,
      // Concrete by now. The resolver always returns a model rather than leaving a default to be
      // applied later, because the default that would be applied is a *paid* one and forgetting
      // it is this deployment buying tokens for a stranger.
      model: access.model,
      // Whether, never which — the worker re-opens the key by user id, so plaintext credentials
      // never reach the queue, a query log or a backup.
      billsToUser: access.credentials !== undefined,
    });

    getLogger().info({ requestId: id, sessionId }, "turn request queued");

    return c.json({ accepted: true }, 202);
  });

  app.post("/sessions/:sessionId/turns/cancel", async (c) => {
    // Authorized before the registry is touched: cancelling somebody else's turn is exactly
    // as damaging as starting one, and a 409 for "nothing is running" would otherwise tell a
    // stranger whether a session they cannot see is busy.
    const found = await findOwnedSession(deps.sessions, c.req.param("sessionId"), c.get("userId"));
    if (!found.ok) return c.json({ error: found.error.message }, found.error.status);
    const { sessionId } = found.value;

    // The durable half, and the only one that reaches a turn running on another pod: a queued
    // request is failed outright so it is never claimed, and a leased one is flagged for the
    // worker holding it, which aborts on its next renewal.
    const outcome = await deps.queue.requestCancel(sessionId);

    // Nothing in flight is a race, not a failure: the user clicked as the turn was ending. The
    // status says so rather than reporting a server error for something nobody did wrong.
    if (!outcome.cancelled) {
      return c.json({ error: "no turn is running for this session" }, 409);
    }

    // The fast path, for when the turn happens to be running in this process. Does nothing at all
    // when it is not, which is correct — the flag above has already reached it.
    deps.registry.cancel(sessionId);

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
 *
 * **The quota is asked first, and the order is load-bearing now that it was not before.** The rate
 * check *records* an accepted turn, so asking it ahead of a quota that then refuses spends an hour
 * of somebody's allowance on a turn that never ran — and since the window moved into Postgres that
 * is durable and cluster-wide rather than a soon-forgotten entry in one process's map. Somebody at
 * their sandbox limit hammering the button would burn their whole hour without starting anything.
 * The visible consequence is that a caller who is at *both* limits is told about the one they can
 * do something about, which is the better of the two answers anyway.
 */
async function refuse(
  deps: TurnRouteDeps,
  session: SessionRecord,
  userId: string,
  /** Whether this turn is billed to the asker. False means the deployment is paying. */
  paysTheirOwnWay: boolean,
): Promise<((c: Context) => Response) | undefined> {
  const { limits } = deps;
  if (limits === undefined) return undefined;

  // The tighter pair when this deployment is paying. Somebody spending their own money is
  // limited to stop a runaway loop; somebody spending ours is limited because that is the
  // whole reason the door can be open to strangers at all.
  const rateLimiter = paysTheirOwnWay ? limits.rate : limits.freeRate;
  const sandboxLimits = paysTheirOwnWay ? limits.sandboxes : limits.freeSandboxes;

  // Reads nothing and writes nothing, so a turn refused here has cost the asker nothing either.
  const quota = await checkSandboxQuota({
    projects: limits.projects,
    userId,
    sessionSandboxId: session.sandboxId,
    limits: sandboxLimits,
  });
  if (!quota.allowed) {
    return (c) => c.json({ error: quota.message, code: "sandbox_quota_exceeded" }, 409);
  }

  // Awaited, and it records: the window lives in Postgres, so every replica is deciding against
  // one allowance rather than each holding its own copy of it.
  const rate = await rateLimiter.check(userId);
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
