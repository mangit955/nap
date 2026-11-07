import { PlanIntentSchema } from "@nap/shared/agent-plan";
import { appTestTarget } from "@nap/shared/app-testing";
import { MediaAttachmentsSchema } from "@nap/shared/media";
import { MODEL_MEDIA_UNSUPPORTED, modelSupportsImages } from "@nap/shared/model-capabilities";
import { pendingPlan } from "@nap/shared/plan-mode";
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
 *   - **Admission returns the durable request ID.** Execution arrives as session events. A
 *     pending caller can also read that row's status, since a queued cancellation emits none.
 *   - **Cancellation is a row, not a `Map`.** `requestCancel` reaches a turn running on any pod,
 *     which the old registry could not. A wake-up then tells that pod to read the row now rather
 *     than at its next renewal, and the registry is still consulted for the case where the turn
 *     happens to be running here — see `registry.ts`.
 *
 * A session that does not exist is refused here as well as inside the runtime. The runtime's
 * answer is a failed turn with no event — correctly, since an event needs a session to belong
 * to — and a client waiting on a socket would simply never hear anything.
 */

import { getLogger } from "@nap/shared/logging";
import type { CancelChannel } from "@nap/shared/ports/cancel-channel";
import type { EventBus } from "@nap/shared/ports/event-bus";
import type { EventStore } from "@nap/shared/ports/event-store";
import type { ModelCredentials } from "@nap/shared/ports/llm-provider";
import type { ProjectStore } from "@nap/shared/ports/project-store";
import type { SessionRecord, SessionStore } from "@nap/shared/ports/session-store";
import type { SteerQueue } from "@nap/shared/ports/steer-queue";
import type { TurnQueue } from "@nap/shared/ports/turn-queue";
import type { TurnRateLimiter } from "@nap/shared/ports/turn-rate-limit";
import { isUnnamed, titleFromPrompt } from "@nap/shared/project-title";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { findOwnedSession } from "../auth/owned-session.ts";
import type { AuthVariables } from "../auth/require-user.ts";
import { refusalStatus, resolveTurnAccess } from "./model-access.ts";
import type { TurnRegistry } from "./registry.ts";
import { checkSandboxQuota, type SandboxLimits } from "./sandbox-quota.ts";

export type TurnRouteDeps = {
  /**
   * Where an admitted turn goes, and where a message sent to a running one waits for it. A worker
   * takes both from here; this route never runs anything.
   */
  queue: TurnQueue & SteerQueue;
  /**
   * Which turns are running *in this process*, which only a composition running every role at once
   * has any of: scripts and tests. Never the durable answer. See `./registry.ts`.
   */
  registry: TurnRegistry;
  /**
   * Tells whichever worker holds a flagged request to read the flag now. Absent where nothing
   * crosses processes, which is those same scripts and tests: there, `registry` reaches it.
   */
  cancels?: Pick<CancelChannel, "announce">;
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
  attachments: MediaAttachmentsSchema.optional(),
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
  /**
   * Asking for a plan, or approving one (ADR-0025). Absent is an ordinary turn. The asker's
   * choice for this turn alone, so it travels with the prompt onto the queued request.
   */
  plan: PlanIntentSchema.optional(),
});

/**
 * A message sent while a turn runs (ADR-0028). Its id is the client's, so a retry is the same
 * message. No attachments: images take the media path a prompt takes, so the client sends those as
 * a turn. No approval: an approval names a waiting plan, and nothing waits while a turn runs.
 */
const SteerBodySchema = z.strictObject({
  id: z.uuid(),
  message: z
    .string()
    .transform((text) => text.trim())
    .refine((text) => text.length > 0, { message: "message must not be empty" })
    .refine((text) => text !== "/compact", {
      message: "Send /compact once the turn has finished.",
    }),
  model: z.string().min(1).optional(),
  plan: PlanIntentSchema.optional().refine((plan) => plan?.intent !== "approve", {
    message: "Approve a plan from its card, once the turn has finished.",
  }),
});

export function registerTurnRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  deps: TurnRouteDeps,
  events: EventStore,
  bus: EventBus,
): void {
  app.post("/sessions/:sessionId/tests", async (c) => {
    const found = await findOwnedSession(deps.sessions, c.req.param("sessionId"), c.get("userId"));
    if (!found.ok) return c.json({ error: found.error.message }, found.error.status);
    const body = z
      .strictObject({ jobId: z.uuid(), model: z.string().min(1).optional() })
      .safeParse(await readJson(c.req.raw));
    if (!body.success)
      return c.json({ error: "Choose a completed job and a model to test it." }, 400);
    const { sessionId } = found.value;
    const target = appTestTarget(await events.readFrom(sessionId, 0));
    if (!target || target.jobId !== body.data.jobId)
      return c.json({ error: "This job is no longer the latest completed checkpoint." }, 409);
    if (await deps.queue.hasPending(sessionId))
      return c.json({ error: "Wait for the current turn to finish before testing." }, 409);
    const key = (await deps.keys?.(c.get("userId"))) ?? null;
    const access = resolveTurnAccess({
      requested: body.data.model,
      key,
      allowed: deps.allowedModels,
      freeModel: deps.freeModel,
      defaultModel: deps.defaultModel,
    });
    if (!access.ok)
      return c.json({ error: access.message, code: access.code }, refusalStatus(access.code));
    if (!modelSupportsImages(access.model))
      return c.json({ error: MODEL_MEDIA_UNSUPPORTED, code: "model_media_unsupported" }, 400);
    const refusal = await refuse(deps, found.value, c.get("userId"), key !== null);
    if (refusal) return refusal(c);
    const id = crypto.randomUUID();
    await deps.queue.enqueue({
      id,
      sessionId,
      userId: c.get("userId"),
      kind: "test",
      message: target.jobId,
      model: access.model,
      billsToUser: access.credentials !== undefined,
    });
    return c.json({ accepted: true, requestId: id }, 202);
  });
  app.get("/sessions/:sessionId/activity", async (c) => {
    const found = await findOwnedSession(deps.sessions, c.req.param("sessionId"), c.get("userId"));
    if (!found.ok) return c.json({ error: found.error.message }, found.error.status);
    const cursor = z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().nonnegative())
      .safeParse(c.req.query("cursor") ?? "0");
    if (!cursor.success) return c.json({ error: "invalid event cursor" }, 400);
    const { sessionId } = found.value;
    c.header("cache-control", "no-store");
    // Include the cursor's row to verify coverage rather than trusting a client watermark.
    // Reading the prefix BEFORE the queue is essential: an admission after the queue read
    // could otherwise put its prompt inside a falsely idle prefix.
    const prefix = await events.readFrom(sessionId, Math.max(0, cursor.data - 1));
    const throughSeq = prefix.at(-1)?.seq ?? 0;
    if (throughSeq < cursor.data) return c.json({ error: "event cursor is ahead of history" }, 409);
    const active = await deps.queue.hasPending(sessionId);
    return c.json({ sessionId, throughSeq, active });
  });
  app.post("/sessions/:sessionId/turns", async (c) => {
    const found = await findOwnedSession(deps.sessions, c.req.param("sessionId"), c.get("userId"));
    if (!found.ok) return c.json({ error: found.error.message }, found.error.status);

    const body = TurnBodySchema.safeParse(await readJson(c.req.raw));
    if (!body.success) {
      return c.json({ error: body.error.issues.map((issue) => issue.message).join("; ") }, 400);
    }

    if (body.data.message === "/compact") {
      if (body.data.attachments?.length)
        return c.json({ error: "Send /compact without attachments." }, 400);
      if (body.data.plan !== undefined)
        return c.json({ error: "Send /compact as an ordinary message, not in plan mode." }, 400);
      if (await deps.queue.anyLeased([found.value.sessionId]))
        return c.json({ error: "Wait for the current turn to finish before compacting." }, 409);
    }

    // An approval has to name the plan that is waiting, and nothing may be queued ahead of it:
    // whatever runs first is the next message, and the next message settles the plan. Refused
    // here, before any allowance is spent, and checked again under the lease, where the log stops
    // moving (`pendingPlan`, ADR-0025).
    if (body.data.plan?.intent === "approve") {
      const { sessionId } = found.value;
      if (await deps.queue.hasPending(sessionId))
        return c.json({ error: "Wait for the current turn to finish before approving." }, 409);
      if (pendingPlan(await events.readFrom(sessionId, 0), body.data.plan.planTurnId) === undefined)
        return c.json({ error: "That plan is no longer waiting for approval." }, 409);
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
      return c.json({ error: access.message, code: access.code }, refusalStatus(access.code));
    }
    if (body.data.attachments?.length && !modelSupportsImages(access.model)) {
      return c.json({ error: MODEL_MEDIA_UNSUPPORTED, code: "model_media_unsupported" }, 400);
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
    if (body.data.message !== "/compact")
      await nameFromFirstPrompt(deps, found.value, c.get("userId"), body.data.message);

    // The turn's identity, allocated here and durable a line later. It is the request's id *and*
    // the turn id every event of this turn is written under, which is what lets the janitor close
    // out a turn whose worker died without it, on a pod that never ran one. See
    // `docs/scaling-design.md` §6.
    const id = crypto.randomUUID();

    // Where admission ends. Durable before the response is written, so a pod that dies in the next
    // millisecond costs the turn a delay rather than the turn itself.
    await deps.queue.enqueue({
      id,
      sessionId,
      userId: c.get("userId"),
      kind: "turn",
      message: body.data.message,
      ...(body.data.attachments === undefined ? {} : { attachments: body.data.attachments }),
      ...(body.data.plan === undefined ? {} : { plan: body.data.plan }),
      // Concrete by now. The resolver always returns a model rather than leaving a default to be
      // applied later, because the default that would be applied is a *paid* one and forgetting
      // it is this deployment buying tokens for a stranger.
      model: access.model,
      // Whether, never which — the worker re-opens the key by user id, so plaintext credentials
      // never reach the queue, a query log or a backup.
      billsToUser: access.credentials !== undefined,
    });

    getLogger().info({ requestId: id, sessionId }, "turn request queued");

    return c.json({ accepted: true, requestId: id }, 202);
  });

  /**
   * A message sent while a turn runs: it joins that turn at its next step, or, when nothing can take
   * it, becomes the next turn (ADR-0028).
   *
   * **Admitted exactly as a prompt is**, in the same order — ownership, model access, the sandbox
   * quota, then the rate limit, which records — and charged whichever way it lands. Charging only a
   * message that becomes a turn would let anybody turn steers into free turns by sending them as a
   * turn ends, which is when the ones nothing read are queued. Where it lands is the queue's
   * decision, made under a lock on the running request; the route only reports it.
   *
   * A retried id is answered from what the first attempt did, before anything is charged.
   */
  app.post("/sessions/:sessionId/steers", async (c) => {
    const found = await findOwnedSession(deps.sessions, c.req.param("sessionId"), c.get("userId"));
    if (!found.ok) return c.json({ error: found.error.message }, found.error.status);
    const body = SteerBodySchema.safeParse(await readJson(c.req.raw));
    if (!body.success)
      return c.json({ error: body.error.issues.map((issue) => issue.message).join("; ") }, 400);

    const { sessionId } = found.value;
    const userId = c.get("userId");
    const { id } = body.data;
    const conflict = () =>
      c.json({ error: "That message id is already in use.", code: "message_id_in_use" }, 409);

    const earlier = await deps.queue.find({ id, sessionId, userId });
    if (earlier?.as === "conflict") return conflict();
    if (earlier !== null) return c.json({ accepted: true, requestId: id, as: earlier.as }, 202);

    const key = (await deps.keys?.(userId)) ?? null;
    const access = resolveTurnAccess({
      requested: body.data.model,
      key,
      allowed: deps.allowedModels,
      freeModel: deps.freeModel,
      defaultModel: deps.defaultModel,
    });
    if (!access.ok)
      return c.json({ error: access.message, code: access.code }, refusalStatus(access.code));
    const refusal = await refuse(deps, found.value, userId, key !== null);
    if (refusal !== undefined) return refusal(c);

    const admitted = await deps.queue.steer({
      id,
      sessionId,
      userId,
      message: body.data.message,
      ...(body.data.plan === undefined ? {} : { plan: body.data.plan }),
      model: access.model,
      billsToUser: access.credentials !== undefined,
    });
    if (admitted.as === "conflict") return conflict();

    if (admitted.as === "steer") {
      // After the admission commits, so the log never shows a steer the queue does not hold. The
      // worker may record reading it before this lands; every reader of the log allows for that.
      // Under the request it joined, which is the turn it will be read in or answered for. A
      // failure here loses only the waiting bubble in other tabs: the steer is admitted either way.
      try {
        const received = await events.append({
          type: "steer.received",
          sessionId,
          turnId: admitted.requestId,
          createdAt: new Date().toISOString(),
          payload: { steerId: id, text: body.data.message },
        });
        await bus.publish(received);
      } catch (error) {
        getLogger().warn({ err: error, steerId: id }, "a steer was admitted but not announced");
      }
    }

    getLogger().info({ steerId: id, sessionId, as: admitted.as }, "steer admitted");
    return c.json({ accepted: true, requestId: id, as: admitted.as }, 202);
  });

  app.get("/sessions/:sessionId/turns/:requestId", async (c) => {
    const found = await findOwnedSession(deps.sessions, c.req.param("sessionId"), c.get("userId"));
    if (!found.ok) return c.json({ error: found.error.message }, found.error.status);
    const id = z.uuid().safeParse(c.req.param("requestId"));
    if (!id.success) return c.json({ error: "invalid request id" }, 400);
    const status = await deps.queue.getStatus({
      id: id.data,
      sessionId: found.value.sessionId,
      userId: c.get("userId"),
    });
    c.header("cache-control", "no-store");
    if (status === null) return c.json({ error: "turn request not found" }, 404);
    return c.json(status);
  });

  app.post("/sessions/:sessionId/turns/cancel", async (c) => {
    // Authorized before the registry is touched: cancelling somebody else's turn is exactly
    // as damaging as starting one, and a 409 for "nothing is running" would otherwise tell a
    // stranger whether a session they cannot see is busy.
    const found = await findOwnedSession(deps.sessions, c.req.param("sessionId"), c.get("userId"));
    if (!found.ok) return c.json({ error: found.error.message }, found.error.status);
    const { sessionId } = found.value;

    // The durable half, and the authority: a queued request is failed outright so it is never
    // claimed, and a leased one is flagged for the worker holding it. Everything below only makes
    // the worker notice sooner, and its next renewal finds this flag if all of that is lost.
    const outcome = await deps.queue.requestCancel(sessionId);

    // Nothing in flight is a race, not a failure: the user clicked as the turn was ending. The
    // status says so rather than reporting a server error for something nobody did wrong.
    if (!outcome.cancelled) {
      return c.json({ error: "no turn is running for this session" }, 409);
    }

    // Only for a leased request, and only by its id, and only now that the flag has committed: a
    // worker told any earlier would read an unflagged row and carry on. A queued request has
    // nobody to tell.
    if (outcome.was === "leased") {
      deps.cancels?.announce(outcome.requestId);
      deps.registry.cancel(outcome.requestId);
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
