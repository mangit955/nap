import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import type { Runtime, TurnOutcome, TurnRequest } from "@nap/shared/ports/runtime";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createLogger } from "../logger.ts";
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

function app(
  runtime: Runtime,
  registry = new TurnRegistry(),
): { app: Hono; registry: TurnRegistry } {
  return {
    app: createApp({
      logger: silent(),
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

const post = (hono: Hono, path: string, body?: unknown) =>
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
      stream: {
        store: new InMemoryEventStore(),
        bus: new InMemoryEventBus(),
        upgradeWebSocket: async () => new Response(null),
      },
    });

    expect((await post(unwired, `/sessions/${SESSION}/turns`, { message: "hi" })).status).toBe(404);
  });
});
