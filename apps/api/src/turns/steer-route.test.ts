/**
 * `POST /sessions/:sessionId/steers`: a message sent while a turn runs (ADR-0027).
 *
 * The route admits a steer exactly as it admits a prompt — ownership, model access, the sandbox
 * quota and then the rate limit, each charged once — and only then lets the queue decide whether
 * it joins the running turn or becomes the next one. What is asserted is where the message landed,
 * what was charged for it, and what the log says, never how either half runs.
 */

import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { FAKE_OWNER, InMemoryProjectStore } from "@nap/db/testing/in-memory-project-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemoryTurnQueue } from "@nap/db/testing/in-memory-turn-queue";
import { InMemoryTurnRateLimiter } from "@nap/db/testing/in-memory-turn-rate-limiter";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { TurnRegistry } from "./registry.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const SOMEBODY_ELSES = "3e0abc41-6f5d-4a8e-8b9c-4d5e6f708192";
const ALLOWED = ["openai/gpt-5.6-luna", "anthropic/claude-opus-5", "openai/gpt-oss-20b:free"];
const FREE_MODEL = "openai/gpt-oss-20b:free";

let queue: InMemoryTurnQueue;
let store: InMemoryEventStore;
let bus: InMemoryEventBus;
let rate: InMemoryTurnRateLimiter;
let published: StoredEvent[];

beforeEach(() => {
  queue = new InMemoryTurnQueue();
  store = new InMemoryEventStore();
  bus = new InMemoryEventBus();
  rate = new InMemoryTurnRateLimiter({ limit: 100, windowMs: 60 * 60 * 1000 });
  published = [];
  bus.subscribe(SESSION, (event) => published.push(event));
});

function app(options: { perUser?: number; running?: number } = {}): Hono {
  const projects = new InMemoryProjectStore(
    Array.from({ length: options.running ?? 0 }, (_, index) => ({
      projectId: `p${index}`,
      name: `p${index}`,
      status: "ready" as const,
      sandboxId: `sbx-${index}`,
      updatedAt: "2026-08-10T11:00:00.000Z",
      sessionIds: [],
    })),
  );
  return createApp({
    logger: createLogger({ level: "silent" }, { write: () => {} }),
    authenticate: async () => ({ userId: FAKE_OWNER, isAnonymous: false }),
    stream: { store, bus, upgradeWebSocket: async () => new Response(null) },
    turns: {
      queue,
      registry: new TurnRegistry(),
      projects: new InMemoryProjectStore([
        {
          projectId: "project-1",
          name: "Notes",
          status: "ready",
          sandboxId: null,
          updatedAt: "2026-08-12T12:00:00.000Z",
          sessionIds: [SESSION],
        },
      ]),
      allowedModels: ALLOWED,
      keys: async () => ({ platform: "openrouter", apiKey: "sk-or-theirs" }),
      freeModel: FREE_MODEL,
      defaultModel: ALLOWED[0] ?? "",
      sessions: new InMemorySessionStore([
        { sessionId: SESSION, projectId: "project-1" },
        { sessionId: SOMEBODY_ELSES, projectId: "project-2", userId: "somebody-else" },
      ]),
      limits: {
        rate,
        freeRate: new InMemoryTurnRateLimiter({ limit: 100, windowMs: 60 * 60 * 1000 }),
        projects,
        sandboxes: { perUser: options.perUser ?? 100, total: 100 },
        freeSandboxes: { perUser: 100, total: 100 },
      },
    },
  }) as unknown as Hono;
}

function send(hono: Hono, body: Record<string, unknown>, session = SESSION) {
  return hono.request(`/sessions/${session}/steers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A turn running on the session, leased the way a worker holds one. */
async function running(): Promise<string> {
  const id = crypto.randomUUID();
  await queue.enqueue({
    id,
    sessionId: SESSION,
    userId: FAKE_OWNER,
    kind: "turn",
    message: "build a notes app",
    model: ALLOWED[0] ?? "",
    billsToUser: true,
  });
  await queue.claim("worker-a");
  return id;
}

describe("POST /sessions/:sessionId/steers", () => {
  it("joins the turn that is running, and says so in the log", async () => {
    const requestId = await running();
    const id = crypto.randomUUID();

    const response = await send(app(), { id, message: "  Use Postgres instead  " });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true, requestId: id, as: "steer" });
    expect(await queue.steersOf(requestId)).toEqual([
      { id, text: "Use Postgres instead", state: "pending" },
    ]);
    // Under the request it joined, durable and then published, so every tab shows it waiting.
    const log = await store.readFrom(SESSION, 0);
    expect(log.map(({ type, turnId, payload }) => ({ type, turnId, payload }))).toEqual([
      {
        type: "steer.received",
        turnId: requestId,
        payload: { steerId: id, text: "Use Postgres instead" },
      },
    ]);
    expect(published).toEqual(log);
    // It did not queue a turn behind the one running.
    expect(queue.enqueued.map((request) => request.id)).toEqual([requestId]);
  });

  it("becomes the next turn when nothing is running, on the model the route resolved", async () => {
    const id = crypto.randomUUID();

    const response = await send(app(), {
      id,
      message: "Add tags",
      model: "anthropic/claude-opus-5",
      plan: { intent: "propose" },
    });

    await expect(response.json()).resolves.toEqual({ accepted: true, requestId: id, as: "turn" });
    expect(queue.enqueued).toEqual([
      {
        id,
        sessionId: SESSION,
        userId: FAKE_OWNER,
        kind: "turn",
        message: "Add tags",
        plan: { intent: "propose" },
        model: "anthropic/claude-opus-5",
        billsToUser: true,
      },
    ]);
    // A turn's own prompt is its record; nothing says a steer was ever waiting.
    expect(await store.readFrom(SESSION, 0)).toEqual([]);
  });

  it("answers a retried id with what the first attempt did, charged and recorded once", async () => {
    await running();
    const id = crypto.randomUUID();
    const hono = app();

    const first = await send(hono, { id, message: "Use Postgres" });
    const retried = await send(hono, { id, message: "Use Postgres" });

    expect(await retried.json()).toEqual(await first.json());
    expect(rate.size).toBe(1);
    expect(await store.readFrom(SESSION, 0)).toHaveLength(1);
  });

  it("refuses an id that is already somebody else's message", async () => {
    await queue.enqueue({
      id: "7d6a1c3b-2e4f-4a5b-8c9d-0e1f2a3b4c5d",
      sessionId: SOMEBODY_ELSES,
      userId: "somebody-else",
      kind: "turn",
      message: "theirs",
      model: ALLOWED[0] ?? "",
      billsToUser: false,
    });

    const response = await send(app(), {
      id: "7d6a1c3b-2e4f-4a5b-8c9d-0e1f2a3b4c5d",
      message: "mine",
    });

    expect(response.status).toBe(409);
    expect(rate.size).toBe(0);
  });

  it("is limited exactly as a prompt is, and a refusal writes and charges nothing", async () => {
    await running();
    const limited = new InMemoryTurnRateLimiter({ limit: 1, windowMs: 60_000 });
    rate = limited;
    const hono = app();
    await send(hono, { id: crypto.randomUUID(), message: "one" });

    const refused = await send(hono, { id: crypto.randomUUID(), message: "two" });

    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).not.toBeNull();
    expect((await store.readFrom(SESSION, 0)).map((event) => event.type)).toEqual([
      "steer.received",
    ]);

    const quota = await send(app({ perUser: 1, running: 1 }), {
      id: crypto.randomUUID(),
      message: "three",
    });
    expect(quota.status).toBe(409);
    await expect(quota.json()).resolves.toMatchObject({ code: "sandbox_quota_exceeded" });
  });

  it("refuses a model the caller may not name before charging anything", async () => {
    await running();
    const response = await send(app(), {
      id: crypto.randomUUID(),
      message: "hi",
      model: "openai/o3-pro-max-expensive",
    });
    expect(response.status).toBe(400);
    expect(rate.size).toBe(0);
  });

  it("does not take what only a turn of its own can carry", async () => {
    await running();
    const hono = app();
    for (const body of [
      { message: "/compact" },
      { message: "Approved.", plan: { intent: "approve", planTurnId: crypto.randomUUID() } },
      {
        message: "like this",
        attachments: [
          {
            kind: "image",
            name: "a.jpg",
            frames: [{ mediaType: "image/jpeg", data: "/9j/", timestamp: 0 }],
          },
        ],
      },
      { message: "   " },
    ]) {
      const response = await send(hono, { id: crypto.randomUUID(), ...body });
      expect(response.status).toBe(400);
    }
    expect((await send(hono, { id: "not-a-uuid", message: "hi" })).status).toBe(400);
    expect(rate.size).toBe(0);
    expect(await store.readFrom(SESSION, 0)).toEqual([]);
  });

  it("is somebody else's session not found, as every route answers it", async () => {
    const response = await send(app(), { id: crypto.randomUUID(), message: "hi" }, SOMEBODY_ELSES);
    expect(response.status).toBe(404);
  });
});
