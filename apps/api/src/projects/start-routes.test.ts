import { randomUUID } from "node:crypto";
import { InMemoryProjectStore } from "@nap/db/testing/in-memory-project-store";
import { SignInRequiredSchema } from "@nap/shared/api-error";
import type { SessionStartStore } from "@nap/shared/ports/session-start-store";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { AuthVariables } from "../auth/require-user.ts";
import { registerSessionStartRoutes } from "./start-routes.ts";

it("validates model access before creating and replays an admitted operation before checking limits", async () => {
  const result = { projectId: randomUUID(), sessionId: randomUUID(), requestId: randomUUID() };
  const store: SessionStartStore = {
    find: vi.fn(async () => null),
    start: vi.fn(async () => ({ kind: "created" as const, ...result })),
  };
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", randomUUID());
    c.set("isAnonymous", false);
    await next();
  });
  registerSessionStartRoutes(app, {
    store,
    projects: new InMemoryProjectStore(),
    webOrigin: "https://nap.example",
    admission: { allowedModels: ["free", "paid"], freeModel: "free", defaultModel: "paid" },
  });
  const body = {
    operationId: randomUUID(),
    source: { kind: "template" },
    prompt: { message: "Build a page", model: "paid" },
  };
  const send = () =>
    app.request("/sessions/start", {
      method: "POST",
      headers: { origin: "https://nap.example", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await send()).status).toBe(403);
  expect(store.start).not.toHaveBeenCalled();
  body.prompt.model = "free";
  expect((await send()).status).toBe(201);
  expect(store.start).toHaveBeenCalledWith(
    expect.objectContaining({
      request: expect.objectContaining({
        kind: "turn",
        message: "Build a page",
        target: { kind: "api", model: "free", billsToUser: false },
      }),
    }),
  );
  const admitted = vi.mocked(store.start).mock.calls[0]?.[0];
  if (!admitted) throw new Error("Missing admission");
  vi.mocked(store.find).mockResolvedValue({ fingerprint: admitted.fingerprint, result });
  expect((await send()).status).toBe(200);
  expect(store.start).toHaveBeenCalledOnce();
  body.prompt.message = "Different task";
  expect((await send()).status).toBe(409);
});

it("refuses a guest's repository start with the code that asks it to sign in", async () => {
  const store: SessionStartStore = { find: vi.fn(async () => null), start: vi.fn() };
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", randomUUID());
    c.set("isAnonymous", true);
    await next();
  });
  registerSessionStartRoutes(app, {
    store,
    projects: new InMemoryProjectStore(),
    webOrigin: "https://nap.example",
    admission: { allowedModels: ["free"], freeModel: "free", defaultModel: "free" },
  });

  const response = await app.request("/sessions/start", {
    method: "POST",
    headers: { origin: "https://nap.example", "content-type": "application/json" },
    body: JSON.stringify({
      operationId: randomUUID(),
      source: {
        kind: "github",
        installationId: 1,
        repositoryId: 2,
        baseBranch: "main",
        name: "site",
        environment: { setupCommand: null, devCommand: null, previewPort: null },
      },
    }),
  });

  expect(response.status).toBe(403);
  // The same code the GitHub routes mark a guest with, so a client answers all three alike.
  expect(SignInRequiredSchema.safeParse(await response.json()).success).toBe(true);
  expect(store.start).not.toHaveBeenCalled();
});

it.each(["selection", "target"])(
  "refuses unsupported root %s before reading API credentials or admitting work",
  async (field) => {
    const store: SessionStartStore = {
      find: vi.fn(async () => null),
      start: vi.fn<SessionStartStore["start"]>(async () => ({
        kind: "created",
        projectId: randomUUID(),
        sessionId: randomUUID(),
        requestId: randomUUID(),
      })),
    };
    const keys = vi.fn(async () => null);
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use("*", async (c, next) => {
      c.set("userId", randomUUID());
      c.set("isAnonymous", false);
      await next();
    });
    registerSessionStartRoutes(app, {
      store,
      projects: new InMemoryProjectStore(),
      webOrigin: "https://nap.example",
      admission: { keys, allowedModels: ["free"], freeModel: "free", defaultModel: "free" },
    });
    const response = await app.request("/sessions/start", {
      method: "POST",
      headers: { origin: "https://nap.example", "content-type": "application/json" },
      body: JSON.stringify({
        operationId: randomUUID(),
        source: { kind: "template" },
        prompt: { message: "Build" },
        [field]: { kind: "subscription", accountId: randomUUID(), model: "native" },
      }),
    });
    expect(response.status).toBe(400);
    expect(keys).not.toHaveBeenCalled();
    expect(store.start).not.toHaveBeenCalled();
  },
);
