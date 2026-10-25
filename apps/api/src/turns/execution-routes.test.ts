import { FAKE_OWNER } from "@nap/db/testing/in-memory-project-store";
import { InMemoryProviderAccountStore } from "@nap/db/testing/in-memory-provider-account-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { Hono } from "hono";
import { expect, it } from "vitest";
import type { AuthVariables } from "../auth/require-user.ts";
import { SubscriptionAccess } from "../providers/subscription-access.ts";
import { registerExecutionRoutes } from "./execution-routes.ts";

const SESSION = "00000000-0000-4000-8000-000000000099";
const WEB = "http://web.test";
function fixture(options: { userId?: string; anonymous?: boolean; installed?: boolean } = {}) {
  const sessions = new InMemorySessionStore([{ sessionId: SESSION, projectId: "fixture" }]);
  const accounts = new InMemoryProviderAccountStore();
  const subscriptions = new SubscriptionAccess({
    accounts,
    providers: new Map(
      options.installed
        ? [["claude", [{ id: "native-fixture", label: "Native fixture", supportsImages: true }]]]
        : [],
    ),
  });
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", options.userId ?? FAKE_OWNER);
    c.set("isAnonymous", options.anonymous ?? false);
    c.set("authSessionId", null);
    await next();
  });
  registerExecutionRoutes(app, {
    selections: sessions,
    subscriptions,
    allowedModels: ["api-fixture"],
    webOrigin: WEB,
  });
  const send = (body: unknown, origin = WEB) =>
    app.request(`/sessions/${SESSION}/execution`, {
      method: "PATCH",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, accounts, sessions, send };
}
it("persists an owned API preference and rejects unknown authorization fields", async () => {
  const f = fixture();
  const before = await f.app.request(`/sessions/${SESSION}/execution`);
  expect(before.status).toBe(200);
  expect(before.headers.get("cache-control")).toBe("no-store");
  expect(await before.json()).toEqual({ selection: null });
  expect((await f.send({ kind: "api", model: "api-fixture" })).status).toBe(200);
  expect(await f.sessions.selection(FAKE_OWNER, SESSION)).toEqual({
    selection: { kind: "api", model: "api-fixture" },
  });
  expect((await f.send({ kind: "api", model: "api-fixture", billsToUser: false })).status).toBe(
    400,
  );
  expect((await f.send({ kind: "api", model: "unknown" })).status).toBe(400);
});
it("rejects cross-owner and cross-origin preference writes", async () => {
  const wrong = fixture({ userId: "00000000-0000-4000-8000-000000000098" });
  expect((await wrong.send({ kind: "api", model: "api-fixture" })).status).toBe(404);
  expect((await wrong.app.request(`/sessions/${SESSION}/execution`)).status).toBe(404);
  const f = fixture();
  expect((await f.send({ kind: "api", model: "api-fixture" }, "https://evil.example")).status).toBe(
    403,
  );
  expect(await f.sessions.selection(FAKE_OWNER, SESSION)).toEqual({ selection: null });
});
it("retains a provider choice as intent without treating it as successful authentication", async () => {
  const f = fixture({ installed: true });
  const account = await f.accounts.create({ userId: FAKE_OWNER, driver: "claude", label: "Work" });
  const selection = { kind: "subscription", model: "native-fixture", accountId: account.id };
  const result = await f.send(selection);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ selection });
  expect((await f.accounts.get(FAKE_OWNER, account.id))?.auth.status).toBe("unauthenticated");
  await f.accounts.remove(FAKE_OWNER, account.id);
  expect(await (await f.app.request(`/sessions/${SESSION}/execution`)).json()).toEqual({
    selection,
  });
});
it("refuses anonymous native selection and unconfigured providers without choosing an API model", async () => {
  const guest = fixture({ anonymous: true, installed: true });
  expect(
    (await guest.send({ kind: "subscription", accountId: SESSION, model: "native-fixture" }))
      .status,
  ).toBe(403);
  const f = fixture();
  const account = await f.accounts.create({ userId: FAKE_OWNER, driver: "claude", label: null });
  expect(
    (await f.send({ kind: "subscription", accountId: account.id, model: "native-fixture" })).status,
  ).toBe(503);
  expect(await f.sessions.selection(FAKE_OWNER, SESSION)).toEqual({ selection: null });
});
