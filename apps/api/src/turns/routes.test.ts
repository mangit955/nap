import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { FAKE_OWNER, InMemoryProjectStore } from "@nap/db/testing/in-memory-project-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import type { Runtime, TurnOutcome, TurnRequest } from "@nap/shared/ports/runtime";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { TurnRateLimiter } from "./rate-limiter.ts";
import { TurnRegistry } from "./registry.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const UNKNOWN = "2d9fab30-5e4c-4f7d-9a8b-3c4d5e6f7081";
const silent = () => createLogger({ level: "silent" }, { write: () => {} });

/**
 * A runtime that does not finish until a test says so.
 *
 * That is the whole point of the fake: the route must answer while the turn is still running,
 * and a runtime that resolves immediately would make a route that awaits it look identical to
 * one that does not.
 */
class SlowRuntime implements Runtime {
  readonly requests: TurnRequest[] = [];
  #finish: ((outcome: TurnOutcome) => void) | undefined;

  runTurn(request: TurnRequest): Promise<TurnOutcome> {
    this.requests.push(request);
    return new Promise<TurnOutcome>((resolve) => {
      this.#finish = resolve;
    });
  }

  /** Ends the turn the way a completed one ends. */
  complete(): void {
    this.#finish?.({ ok: true, turnId: "t1", commitSha: null });
  }

  get signal(): AbortSignal | undefined {
    return this.requests.at(-1)?.signal;
  }
}

/** A runtime whose turn rejects, which is what makes the background promise dangerous. */
class ThrowingRuntime implements Runtime {
  async runTurn(): Promise<TurnOutcome> {
    throw new Error("the runtime fell over");
  }
}

function app(runtime: Runtime, registry = new TurnRegistry(), logger = silent()) {
  return {
    app: createApp({
      logger,
      // Every guarded route needs a caller; this stands in for a signed-in session cookie.
      authenticate: async () => ({ userId: FAKE_OWNER }),
      stream: {
        store: new InMemoryEventStore(),
        bus: new InMemoryEventBus(),
        upgradeWebSocket: async () => new Response(null),
      },
      turns: {
        runtime,
        registry,
        sessions: new InMemorySessionStore([{ sessionId: SESSION, projectId: "project-1" }]),
      },
    }),
    registry,
  };
}

const post = (hono: { request: Hono["request"] }, path: string, body?: unknown) =>
  hono.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("POST /sessions/:sessionId/turns", () => {
  it("accepts the message and answers before the turn is done", async () => {
    // A turn is a minute of model calls and sandbox commands. The client already has the
    // whole story over the socket, so holding the request open buys nothing and loses to the
    // first proxy with an idle timeout.
    const runtime = new SlowRuntime();
    const { app: hono } = app(runtime);

    const res = await post(hono, `/sessions/${SESSION}/turns`, { message: "build a todo list" });

    expect(res.status).toBe(202);
    expect(runtime.requests).toMatchObject([{ sessionId: SESSION, message: "build a todo list" }]);
    runtime.complete();
  });

  it("hands the turn a signal that cancel can abort", async () => {
    const runtime = new SlowRuntime();
    const { app: hono } = app(runtime);

    await post(hono, `/sessions/${SESSION}/turns`, { message: "hello" });

    expect(runtime.signal).toBeInstanceOf(AbortSignal);
    expect(runtime.signal?.aborted).toBe(false);
    runtime.complete();
  });

  it("404s for a session that does not exist", async () => {
    // Checked here as well as in the runtime: the runtime's own answer is a failed turn with
    // no event, which a client would wait for over a socket that will never say anything.
    const runtime = new SlowRuntime();
    const { app: hono } = app(runtime);

    const res = await post(hono, `/sessions/${UNKNOWN}/turns`, { message: "hello" });

    expect(res.status).toBe(404);
    expect(runtime.requests).toEqual([]);
  });

  it.each([
    ["a body that is not JSON", undefined],
    ["no message", {}],
    ["an empty message", { message: "   " }],
    ["a message that is not a string", { message: 42 }],
  ])("400s for %s, and starts nothing", async (_name, body) => {
    const runtime = new SlowRuntime();
    const { app: hono } = app(runtime);

    const res = await post(hono, `/sessions/${SESSION}/turns`, body);

    expect(res.status).toBe(400);
    expect(runtime.requests).toEqual([]);
  });

  it("400s for a session id that is not a uuid", async () => {
    const { app: hono } = app(new SlowRuntime());

    expect((await post(hono, "/sessions/nope/turns", { message: "hi" })).status).toBe(400);
  });

  it("survives a runtime that throws", async () => {
    // The turn runs detached, so nothing awaits its promise. An unhandled rejection under
    // Bun takes the process down — which would mean one broken turn logs every user out.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);

    const { app: hono } = app(new ThrowingRuntime());
    const res = await post(hono, `/sessions/${SESSION}/turns`, { message: "hello" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off("unhandledRejection", onRejection);

    expect(res.status).toBe(202);
    expect(rejections).toEqual([]);
  });

  it("forgets the turn once it settles, so a late cancel is a no-op", async () => {
    const runtime = new SlowRuntime();
    const { app: hono, registry } = app(runtime);

    await post(hono, `/sessions/${SESSION}/turns`, { message: "hello" });
    expect(registry.isRunning(SESSION)).toBe(true);

    runtime.complete();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(registry.isRunning(SESSION)).toBe(false);
  });
});

describe("POST /sessions/:sessionId/turns/cancel", () => {
  it("aborts the running turn", async () => {
    const runtime = new SlowRuntime();
    const { app: hono } = app(runtime);
    await post(hono, `/sessions/${SESSION}/turns`, { message: "hello" });

    const res = await post(hono, `/sessions/${SESSION}/turns/cancel`);

    expect(res.status).toBe(202);
    expect(runtime.signal?.aborted).toBe(true);
    runtime.complete();
  });

  it("409s when the turn already ended", async () => {
    // The click and the last event crossed. Not a server error, and not something to show as
    // a failure — the input is about to re-enable itself anyway.
    const { app: hono } = app(new SlowRuntime());

    const res = await post(hono, `/sessions/${SESSION}/turns/cancel`);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
  });
});

describe("when the app is built without a runtime", () => {
  it("has no turn routes at all", async () => {
    const unwired = createApp({
      logger: silent(),
      // Signed in, so a 404 here is about the route not existing rather than about who is
      // asking — which is what this test is for.
      authenticate: async () => ({ userId: FAKE_OWNER }),
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
    runtime: Runtime;
    turns?: number;
    perUser?: number;
    total?: number;
    running?: { sandboxId: string | null; userId?: string }[];
    sessionSandboxId?: string | null;
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
      authenticate: async () => ({ userId: FAKE_OWNER }),
      stream: {
        store: new InMemoryEventStore(),
        bus: new InMemoryEventBus(),
        upgradeWebSocket: async () => new Response(null),
      },
      turns: {
        runtime: options.runtime,
        registry: new TurnRegistry(),
        sessions: new InMemorySessionStore([
          {
            sessionId: SESSION,
            projectId: "project-1",
            sandboxId: options.sessionSandboxId ?? null,
          },
        ]),
        limits: {
          rate: new TurnRateLimiter({ limit: options.turns ?? 100, windowMs: 60 * 60 * 1000 }),
          projects,
          sandboxes: { perUser: options.perUser ?? 100, total: options.total ?? 100 },
        },
      },
    });
  }

  it("answers 429 with a Retry-After once the rate limit is spent", async () => {
    const runtime = new SlowRuntime();
    const hono = limited({ runtime, turns: 1 });

    expect((await post(hono, `/sessions/${SESSION}/turns`, { message: "one" })).status).toBe(202);
    const refused = await post(hono, `/sessions/${SESSION}/turns`, { message: "two" });

    expect(refused.status).toBe(429);
    // The header specifically: it is the one a proxy or a client library obeys on its own, and
    // a 429 without it invites an immediate retry into the same wall.
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    await expect(refused.json()).resolves.toMatchObject({ code: "rate_limited" });
    runtime.complete();
  });

  it("starts no turn when it refuses one", async () => {
    // Asserted on the runtime, not on the status. A route that answered 429 *after* handing the
    // turn to the runtime would look identical from the outside and cost exactly as much.
    const runtime = new SlowRuntime();
    const hono = limited({ runtime, turns: 0 });

    await post(hono, `/sessions/${SESSION}/turns`, { message: "hello" });

    expect(runtime.requests).toEqual([]);
  });

  it("does not spend the allowance on a request that was never going to run", async () => {
    // A malformed body is refused before the limiter, so a client with a bug does not also lock
    // itself out of the turns it could have made correctly.
    const runtime = new SlowRuntime();
    const hono = limited({ runtime, turns: 1 });

    expect((await post(hono, `/sessions/${SESSION}/turns`, { message: "  " })).status).toBe(400);

    expect((await post(hono, `/sessions/${SESSION}/turns`, { message: "real" })).status).toBe(202);
    runtime.complete();
  });

  it("answers 409 when the caller is at their sandbox cap", async () => {
    const runtime = new SlowRuntime();
    const hono = limited({
      runtime,
      perUser: 1,
      running: [{ sandboxId: "sbx-a" }],
    });

    const refused = await post(hono, `/sessions/${SESSION}/turns`, { message: "hello" });

    // 409 rather than 429: nothing is too fast, the state conflicts — and the fix is to close a
    // project rather than to wait, so `Retry-After` would be a lie.
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ code: "sandbox_quota_exceeded" });
    expect(runtime.requests).toEqual([]);
  });

  it("still accepts a turn in a project that already has a sandbox", async () => {
    // At the cap, but this turn resumes rather than creates. Refusing it would freeze the
    // conversation the user is already in the middle of.
    const runtime = new SlowRuntime();
    const hono = limited({
      runtime,
      perUser: 1,
      running: [{ sandboxId: "sbx-a" }],
      sessionSandboxId: "sbx-a",
    });

    const res = await post(hono, `/sessions/${SESSION}/turns`, { message: "carry on" });

    expect(res.status).toBe(202);
    runtime.complete();
  });

  it("refuses when the process is full even though the caller is under their own cap", async () => {
    const runtime = new SlowRuntime();
    const hono = limited({
      runtime,
      perUser: 5,
      total: 1,
      running: [{ sandboxId: "sbx-x", userId: "00000000-0000-4000-8000-0000000000ff" }],
    });

    const refused = await post(hono, `/sessions/${SESSION}/turns`, { message: "hello" });

    expect(refused.status).toBe(409);
    expect(runtime.requests).toEqual([]);
  });
});

describe("what a detached turn leaves in the log", () => {
  /** Captures real output, since the assertion is about which fields a line actually carries. */
  function capturing() {
    const lines: string[] = [];
    return {
      logger: createLogger({ level: "info" }, { write: (m: string) => lines.push(m) }),
      records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
    };
  }

  it("records how the turn ended under a greppable turn id", async () => {
    // The route answers 202 and never learns the id the runtime generated, so this line — the
    // only one saying how the turn ended from the request's side — has to lift it out of the
    // outcome. Left nested, the turn's own key does not reach it.
    const sink = capturing();
    const runtime = new SlowRuntime();
    const { app: hono } = app(runtime, new TurnRegistry(), sink.logger);

    await post(hono, `/sessions/${SESSION}/turns`, { message: "add a button" });
    runtime.complete();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const settled = sink.records().find((r) => r.msg === "turn settled");
    expect(settled).toMatchObject({ turnId: "t1", sessionId: SESSION });
  });

  it("records a turn that threw, under the session it belonged to", async () => {
    // A throwing runtime is a bug rather than a failed turn, and it produces no event at all —
    // so this line is the only trace. Losing the session id would make it unattributable.
    const sink = capturing();
    const { app: hono } = app(new ThrowingRuntime(), new TurnRegistry(), sink.logger);

    await post(hono, `/sessions/${SESSION}/turns`, { message: "add a button" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const threw = sink.records().find((r) => r.msg === "turn threw");
    expect(threw).toMatchObject({ sessionId: SESSION });
  });
});
