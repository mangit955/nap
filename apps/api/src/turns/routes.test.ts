import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { FAKE_OWNER, InMemoryProjectStore } from "@nap/db/testing/in-memory-project-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemoryTurnQueue } from "@nap/db/testing/in-memory-turn-queue";
import { InMemoryTurnRateLimiter } from "@nap/db/testing/in-memory-turn-rate-limiter";
import { UNTITLED_PROJECT } from "@nap/shared/project-title";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { TurnRegistry } from "./registry.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const UNKNOWN = "2d9fab30-5e4c-4f7d-9a8b-3c4d5e6f7081";
const silent = () => createLogger({ level: "silent" }, { write: () => {} });

/** A project carrying the default name, which is what the auto-namer looks for. */
function unnamedProject(name = UNTITLED_PROJECT) {
  return new InMemoryProjectStore([
    {
      projectId: "project-1",
      name,
      status: "creating" as const,
      sandboxId: null,
      updatedAt: "2026-08-12T12:00:00.000Z",
      sessionIds: [SESSION],
    },
  ]);
}

function app(
  queue: InMemoryTurnQueue,
  registry = new TurnRegistry(),
  logger = silent(),
  projects = unnamedProject(),
) {
  return {
    projects,
    app: createApp({
      logger,
      // Every guarded route needs a caller; this stands in for a signed-in session cookie.
      authenticate: async () => ({ userId: FAKE_OWNER, isAnonymous: false }),
      stream: {
        store: new InMemoryEventStore(),
        bus: new InMemoryEventBus(),
        upgradeWebSocket: async () => new Response(null),
      },
      turns: {
        queue,
        registry,
        projects,
        allowedModels: ALLOWED,
        // Somebody who brought their own key, which is what most of these tests are about —
        // the free tier's narrower rules have their own block below.
        keys: async () => OPENROUTER_KEY,
        freeModel: FREE_MODEL,
        defaultModel: ALLOWED[0] ?? "",
        sessions: new InMemorySessionStore([{ sessionId: SESSION, projectId: "project-1" }]),
      },
    }),
    registry,
    queue,
  };
}

const post = (hono: { request: Hono["request"] }, path: string, body?: unknown) =>
  hono.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** What this deployment will run a turn on, as the route enforces it. */
const ALLOWED = ["openai/gpt-5.6-luna", "anthropic/claude-opus-5", "openai/gpt-oss-20b:free"];
/** What a turn runs on when nobody is paying for it. */
const FREE_MODEL = "openai/gpt-oss-20b:free";
/** A caller who brought their own key, and may therefore reach the paid models. */
const OPENROUTER_KEY = { platform: "openrouter", apiKey: "sk-or-theirs" } as const;

describe("POST /sessions/:sessionId/turns", () => {
  it("accepts the message and answers before the turn is done", async () => {
    // A turn is a minute of model calls and sandbox commands. The client already has the
    // whole story over the socket, so holding the request open buys nothing and loses to the
    // first proxy with an idle timeout.
    const queue = new InMemoryTurnQueue();
    const { app: hono } = app(queue);

    const res = await post(hono, `/sessions/${SESSION}/turns`, { message: "build a todo list" });

    expect(res.status).toBe(202);
    expect(queue.enqueued).toMatchObject([
      { sessionId: SESSION, kind: "turn", message: "build a todo list" },
    ]);
  });

  it("records whether the asker pays, and never their key", async () => {
    // The queue is a table every replica reads, so a credential on it would be plaintext in a
    // query log and in every backup. What it carries is the *fact* — the worker re-opens the key
    // by user id once it has claimed the request.
    const queue = new InMemoryTurnQueue();
    const { app: hono } = app(queue);

    await post(hono, `/sessions/${SESSION}/turns`, { message: "hello" });

    expect(queue.enqueued[0]).toMatchObject({ userId: FAKE_OWNER, billsToUser: true });
    expect(JSON.stringify(queue.enqueued)).not.toContain(OPENROUTER_KEY.apiKey);
  });

  it("404s for a session that does not exist", async () => {
    // Checked here as well as in the runtime: the runtime's own answer is a failed turn with
    // no event, which a client would wait for over a socket that will never say anything. A
    // request queued against a session nobody owns would reach a worker and fail there instead.
    const queue = new InMemoryTurnQueue();
    const { app: hono } = app(queue);

    const res = await post(hono, `/sessions/${UNKNOWN}/turns`, { message: "hello" });

    expect(res.status).toBe(404);
    expect(queue.enqueued).toEqual([]);
  });

  it.each([
    ["a body that is not JSON", undefined],
    ["no message", {}],
    ["an empty message", { message: "   " }],
    ["a message that is not a string", { message: 42 }],
  ])("400s for %s, and queues nothing", async (_name, body) => {
    const queue = new InMemoryTurnQueue();
    const { app: hono } = app(queue);

    const res = await post(hono, `/sessions/${SESSION}/turns`, body);

    expect(res.status).toBe(400);
    expect(queue.enqueued).toEqual([]);
  });

  it("400s for a session id that is not a uuid", async () => {
    const { app: hono } = app(new InMemoryTurnQueue());

    expect((await post(hono, "/sessions/nope/turns", { message: "hi" })).status).toBe(400);
  });
});

describe("POST /sessions/:sessionId/turns/cancel", () => {
  it("stops a request that has not been claimed yet", async () => {
    const queue = new InMemoryTurnQueue();
    const { app: hono } = app(queue);
    await post(hono, `/sessions/${SESSION}/turns`, { message: "hello" });

    const res = await post(hono, `/sessions/${SESSION}/turns/cancel`);

    expect(res.status).toBe(202);
    // Failed outright rather than left queued and skipped: a request with no terminal state is a
    // chat pane with nothing to show.
    expect(await queue.claim("worker-1")).toBeNull();
  });

  it("flags a request a worker is already running, wherever that worker is", async () => {
    // The reason this is a row rather than the `Map` it used to be: the pod holding the socket
    // and the pod running the turn need not be the same one, and only the queue reaches both.
    const queue = new InMemoryTurnQueue();
    const { app: hono } = app(queue);
    await post(hono, `/sessions/${SESSION}/turns`, { message: "hello" });
    const claimed = await queue.claim("some-other-pod");

    const res = await post(hono, `/sessions/${SESSION}/turns/cancel`);

    expect(res.status).toBe(202);
    expect(await queue.renew(claimed?.id ?? "", "some-other-pod")).toEqual({
      held: true,
      cancelRequested: true,
    });
  });

  it("aborts a turn running in this process at once, rather than at its next renewal", async () => {
    // The fast path. The flag above has already reached the worker; this is only so that a cancel
    // landing on the pod that happens to be running the turn is felt immediately.
    const queue = new InMemoryTurnQueue();
    const { app: hono, registry } = app(queue);
    await post(hono, `/sessions/${SESSION}/turns`, { message: "hello" });
    const controller = new AbortController();
    registry.adopt(SESSION, controller);

    await post(hono, `/sessions/${SESSION}/turns/cancel`);

    expect(controller.signal.aborted).toBe(true);
  });

  it("409s when the turn already ended", async () => {
    // The click and the last event crossed. Not a server error, and not something to show as
    // a failure — the input is about to re-enable itself anyway.
    const { app: hono } = app(new InMemoryTurnQueue());

    const res = await post(hono, `/sessions/${SESSION}/turns/cancel`);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
  });
});

describe("when the app is built without a turn queue", () => {
  it("has no turn routes at all", async () => {
    const unwired = createApp({
      logger: silent(),
      // Signed in, so a 404 here is about the route not existing rather than about who is
      // asking — which is what this test is for.
      authenticate: async () => ({ userId: FAKE_OWNER, isAnonymous: false }),
      stream: {
        store: new InMemoryEventStore(),
        bus: new InMemoryEventBus(),
        upgradeWebSocket: async () => new Response(null),
      },
    });

    expect((await post(unwired, `/sessions/${SESSION}/turns`, { message: "hi" })).status).toBe(404);
  });
});

describe("limits", () => {
  /** An app whose limiter allows `turns` per hour and whose sandbox caps are `sandboxes`. */
  function limited(options: {
    queue: InMemoryTurnQueue;
    turns?: number;
    /** The tighter ceilings, which apply when this deployment is paying for the turn. */
    freeTurns?: number;
    freePerUser?: number;
    /** No key of their own, so the free tier's rules and the free tier's limiters apply. */
    noKey?: boolean;
    perUser?: number;
    total?: number;
    running?: { sandboxId: string | null; userId?: string }[];
    sessionSandboxId?: string | null;
    /** Passed in when a test needs to look at what the allowance actually recorded. */
    rate?: InMemoryTurnRateLimiter;
  }) {
    const projects = new InMemoryProjectStore(
      (options.running ?? []).map((project, i) => ({
        projectId: `p${i}`,
        name: `p${i}`,
        status: "ready" as const,
        sandboxId: project.sandboxId,
        updatedAt: "2026-08-10T11:00:00.000Z",
        sessionIds: [],
        ...(project.userId === undefined ? {} : { userId: project.userId }),
      })),
    );

    return createApp({
      logger: silent(),
      authenticate: async () => ({ userId: FAKE_OWNER, isAnonymous: false }),
      stream: {
        store: new InMemoryEventStore(),
        bus: new InMemoryEventBus(),
        upgradeWebSocket: async () => new Response(null),
      },
      turns: {
        queue: options.queue,
        registry: new TurnRegistry(),
        projects: unnamedProject(),
        allowedModels: ALLOWED,
        keys: async () => (options.noKey === true ? null : OPENROUTER_KEY),
        freeModel: FREE_MODEL,
        defaultModel: ALLOWED[0] ?? "",
        sessions: new InMemorySessionStore([
          {
            sessionId: SESSION,
            projectId: "project-1",
            sandboxId: options.sessionSandboxId ?? null,
          },
        ]),
        limits: {
          rate:
            options.rate ??
            new InMemoryTurnRateLimiter({
              limit: options.turns ?? 100,
              windowMs: 60 * 60 * 1000,
            }),
          freeRate: new InMemoryTurnRateLimiter({
            limit: options.freeTurns ?? 100,
            windowMs: 60 * 60 * 1000,
          }),
          projects,
          sandboxes: { perUser: options.perUser ?? 100, total: options.total ?? 100 },
          freeSandboxes: {
            perUser: options.freePerUser ?? 100,
            total: options.total ?? 100,
          },
        },
      },
    });
  }

  it("refuses a model that is not on the allowlist", async () => {
    // A model id taken from a request body and handed to the provider is a stranger choosing
    // what each turn costs — and the expensive one is the one they would choose.
    const queue = new InMemoryTurnQueue();
    const hono = limited({ queue });

    const refused = await post(hono, `/sessions/${SESSION}/turns`, {
      message: "hello",
      model: "openai/o3-pro-max-expensive",
    });

    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toMatchObject({ code: "model_not_allowed" });
    // The refusal has to happen before anything is written down, or the ceiling is decorative.
    expect(queue.enqueued).toEqual([]);
  });

  it("writes an allowed model onto the request", async () => {
    const queue = new InMemoryTurnQueue();
    const hono = limited({ queue });

    const accepted = await post(hono, `/sessions/${SESSION}/turns`, {
      message: "hello",
      model: "anthropic/claude-opus-5",
    });

    expect(accepted.status).toBe(202);
    expect(queue.enqueued[0]).toMatchObject({ model: "anthropic/claude-opus-5" });
  });

  it("resolves the default itself rather than leaving the worker to apply one", async () => {
    // This used to send no model at all and let the provider's own default stand. It cannot
    // any more: which default is right depends on who is asking — a paid one for somebody
    // spending their own money, a free one for everybody else — and that is a fact only this
    // layer has. Leaving it unset would mean a key-less turn silently falling through to
    // `NAP_MODEL`, which this deployment pays for.
    const queue = new InMemoryTurnQueue();
    const hono = limited({ queue });

    await post(hono, `/sessions/${SESSION}/turns`, { message: "hello" });

    expect(queue.enqueued[0]).toMatchObject({ model: ALLOWED[0] });
  });

  it("marks a turn as billed to the caller when they brought a key", async () => {
    // Without this every turn is charged to the deployment — the feature would look complete and
    // change nothing about who pays. It is a flag rather than the key itself: the worker re-opens
    // the credential by user id, so the queue never holds one.
    const queue = new InMemoryTurnQueue();
    const hono = limited({ queue });

    await post(hono, `/sessions/${SESSION}/turns`, { message: "hello" });

    expect(queue.enqueued[0]).toMatchObject({ billsToUser: true });
  });

  it("marks a turn from somebody with no key as the deployment's to pay for", async () => {
    // Which is only safe because the model resolved alongside it is a free one, asserted here
    // too: the two facts are decided together and a mismatch is this deployment buying tokens
    // for a stranger.
    const queue = new InMemoryTurnQueue();
    const hono = limited({ queue, noKey: true });

    await post(hono, `/sessions/${SESSION}/turns`, { message: "hello" });

    expect(queue.enqueued[0]).toMatchObject({ billsToUser: false, model: FREE_MODEL });
  });

  it("refuses a paid model to somebody with no key, and says a key is what is missing", async () => {
    // The rule the whole free tier rests on. The status is 403 rather than 400 because there
    // is something the asker can do about it, and the browser offers the key form on this code.
    const queue = new InMemoryTurnQueue();
    const hono = limited({ queue, noKey: true });

    const refused = await post(hono, `/sessions/${SESSION}/turns`, {
      message: "hello",
      model: "anthropic/claude-opus-5",
    });

    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ code: "byok_required" });
    expect(queue.enqueued).toHaveLength(0);
  });

  it("holds a key-less caller to the tighter turn limit", async () => {
    // Two limiters rather than two numbers on one: a free turn must not consume the allowance
    // somebody's paid turns are counted against, or "5 free turns an hour" would mean
    // something different depending on what else they did that hour.
    const queue = new InMemoryTurnQueue();
    const hono = limited({ queue, noKey: true, turns: 100, freeTurns: 1 });

    await post(hono, `/sessions/${SESSION}/turns`, { message: "one" });
    const second = await post(hono, `/sessions/${SESSION}/turns`, { message: "two" });

    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({ code: "rate_limited" });
  });

  it("leaves a caller with a key on the ordinary turn limit", async () => {
    // The mirror of the test above, and the one that proves the two limiters are really
    // separate: the same tight free ceiling must not apply to somebody paying their own way.
    const queue = new InMemoryTurnQueue();
    const hono = limited({ queue, turns: 100, freeTurns: 1 });

    await post(hono, `/sessions/${SESSION}/turns`, { message: "one" });
    const second = await post(hono, `/sessions/${SESSION}/turns`, { message: "two" });

    expect(second.status).toBe(202);
  });

  it("does not spend the caller's allowance on a model it refused", async () => {
    // A refused attempt that consumed a slot pushes recovery away from anyone retrying, and
    // the advertised wait never arrives. Same rule the rate limiter already follows.
    const queue = new InMemoryTurnQueue();
    const hono = limited({ queue, turns: 1 });

    await post(hono, `/sessions/${SESSION}/turns`, { message: "one", model: "nope/nope" });
    const accepted = await post(hono, `/sessions/${SESSION}/turns`, { message: "two" });

    expect(accepted.status).toBe(202);
  });

  it("answers 429 with a Retry-After once the rate limit is spent", async () => {
    const queue = new InMemoryTurnQueue();
    const hono = limited({ queue, turns: 1 });

    expect((await post(hono, `/sessions/${SESSION}/turns`, { message: "one" })).status).toBe(202);
    const refused = await post(hono, `/sessions/${SESSION}/turns`, { message: "two" });

    expect(refused.status).toBe(429);
    // The header specifically: it is the one a proxy or a client library obeys on its own, and
    // a 429 without it invites an immediate retry into the same wall.
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    await expect(refused.json()).resolves.toMatchObject({ code: "rate_limited" });
  });

  it("starts no turn when it refuses one", async () => {
    // Asserted on the queue, not on the status. A route that answered 429 *after* enqueuing the
    // request would look identical from the outside and cost exactly as much.
    const queue = new InMemoryTurnQueue();
    const hono = limited({ queue, turns: 0 });

    await post(hono, `/sessions/${SESSION}/turns`, { message: "hello" });

    expect(queue.enqueued).toEqual([]);
  });

  it("does not spend the allowance on a request that was never going to run", async () => {
    // A malformed body is refused before the limiter, so a client with a bug does not also lock
    // itself out of the turns it could have made correctly.
    const queue = new InMemoryTurnQueue();
    const hono = limited({ queue, turns: 1 });

    expect((await post(hono, `/sessions/${SESSION}/turns`, { message: "  " })).status).toBe(400);

    expect((await post(hono, `/sessions/${SESSION}/turns`, { message: "real" })).status).toBe(202);
  });

  it("answers 409 when the caller is at their sandbox cap", async () => {
    const queue = new InMemoryTurnQueue();
    const hono = limited({
      queue,
      perUser: 1,
      running: [{ sandboxId: "sbx-a" }],
    });

    const refused = await post(hono, `/sessions/${SESSION}/turns`, { message: "hello" });

    // 409 rather than 429: nothing is too fast, the state conflicts — and the fix is to close a
    // project rather than to wait, so `Retry-After` would be a lie.
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ code: "sandbox_quota_exceeded" });
    expect(queue.enqueued).toEqual([]);
  });

  it("does not spend the turn allowance on a turn the sandbox cap refused", async () => {
    // The rate check *records* an accepted turn, so asking it before the quota would charge
    // somebody an hour of their allowance for a turn that never ran — and the window is in
    // Postgres now, so that charge is durable and cluster-wide rather than one process's map.
    // Somebody at their sandbox limit hammering the button would burn their whole hour.
    const rate = new InMemoryTurnRateLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });
    const queue = new InMemoryTurnQueue();
    const hono = limited({ queue, rate, perUser: 1, running: [{ sandboxId: "sbx-a" }] });

    for (let i = 0; i < 3; i += 1) {
      const refused = await post(hono, `/sessions/${SESSION}/turns`, { message: "hello" });
      expect(refused.status).toBe(409);
    }

    // Nothing recorded at all: the limiter is not tracking this caller, so the whole allowance
    // is still theirs.
    expect(rate.size).toBe(0);
    expect(queue.enqueued).toEqual([]);
  });

  it("still accepts a turn in a project that already has a sandbox", async () => {
    // At the cap, but this turn resumes rather than creates. Refusing it would freeze the
    // conversation the user is already in the middle of.
    const queue = new InMemoryTurnQueue();
    const hono = limited({
      queue,
      perUser: 1,
      running: [{ sandboxId: "sbx-a" }],
      sessionSandboxId: "sbx-a",
    });

    const res = await post(hono, `/sessions/${SESSION}/turns`, { message: "carry on" });

    expect(res.status).toBe(202);
  });

  it("refuses when the process is full even though the caller is under their own cap", async () => {
    const queue = new InMemoryTurnQueue();
    const hono = limited({
      queue,
      perUser: 5,
      total: 1,
      running: [{ sandboxId: "sbx-x", userId: "00000000-0000-4000-8000-0000000000ff" }],
    });

    const refused = await post(hono, `/sessions/${SESSION}/turns`, { message: "hello" });

    expect(refused.status).toBe(409);
    expect(queue.enqueued).toEqual([]);
  });
});

describe("what admission leaves in the log", () => {
  /** Captures real output, since the assertion is about which fields a line actually carries. */
  function capturing() {
    const lines: string[] = [];
    return {
      logger: createLogger({ level: "info" }, { write: (m: string) => lines.push(m) }),
      records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
    };
  }

  it("records the queued request under both ids it will later be found by", async () => {
    // The request never learns the turn id — that is allocated where the turn runs — so this is
    // the one line joining "somebody asked" to a row a worker will claim minutes later. Without
    // the request id, a queued turn that never ran is unattributable to the call that queued it.
    const sink = capturing();
    const queue = new InMemoryTurnQueue();
    const { app: hono } = app(queue, new TurnRegistry(), sink.logger);

    await post(hono, `/sessions/${SESSION}/turns`, { message: "add a button" });

    const queued = sink.records().find((r) => r.msg === "turn request queued");
    expect(queued).toMatchObject({ sessionId: SESSION, requestId: expect.any(String) });
  });
});

describe("naming a project after its first prompt", () => {
  it("names a project that is still untitled", async () => {
    // The whole point: a dashboard of identical "Untitled project" tiles tells nobody which of
    // them is the thing they were working on.
    const { app: hono, projects } = app(new InMemoryTurnQueue());

    const response = await post(hono, `/sessions/${SESSION}/turns`, {
      message: "Build a small to-do app for me.",
    });

    expect(response.status).toBe(202);
    expect((await projects.get("project-1", FAKE_OWNER))?.name).toBe("Small To-do App");
  });

  it("leaves a project that already has a name alone", async () => {
    // A name somebody chose must survive every turn after it. This is the assertion that makes
    // the feature safe rather than merely present.
    const { app: hono, projects } = app(
      new InMemoryTurnQueue(),
      new TurnRegistry(),
      silent(),
      unnamedProject("My Careful Name"),
    );

    await post(hono, `/sessions/${SESSION}/turns`, { message: "now add a dark theme" });

    expect((await projects.get("project-1", FAKE_OWNER))?.name).toBe("My Careful Name");
  });

  it("still starts the turn when the rename fails", async () => {
    // A name is a convenience. Costing somebody their turn because an UPDATE failed would trade
    // the whole feature for a cosmetic one.
    const queue = new InMemoryTurnQueue();
    const { app: hono } = app(
      queue,
      new TurnRegistry(),
      silent(),
      unnamedProject().failRenameWith(new Error("no write")),
    );

    const response = await post(hono, `/sessions/${SESSION}/turns`, { message: "a timer" });

    expect(response.status).toBe(202);
    expect(queue.enqueued).toHaveLength(1);
  });

  it("does not name a project when the turn was refused", async () => {
    // A malformed request is not a first prompt, and naming a project after one would leave a
    // title nobody asked for on a turn that never ran.
    const { app: hono, projects } = app(new InMemoryTurnQueue());

    await post(hono, `/sessions/${SESSION}/turns`, { message: "   " });

    expect((await projects.get("project-1", FAKE_OWNER))?.name).toBe(UNTITLED_PROJECT);
  });
});
