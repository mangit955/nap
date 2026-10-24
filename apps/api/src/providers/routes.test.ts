import { InMemoryProviderAccountStore } from "@nap/db/testing/in-memory-provider-account-store";
import { SIGN_IN_REQUIRED } from "@nap/shared/api-error";
import {
  PROVIDER_ACCOUNT_LIMIT,
  PROVIDER_ACCOUNT_LIMIT_REACHED,
  ProviderAccountsSchema,
  ProviderAccountViewSchema,
  SIGN_IN_UNAVAILABLE,
} from "@nap/shared/provider-accounts-protocol";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../auth/require-user.ts";
import { registerProviderRoutes } from "./routes.ts";
import { ScriptedProviderSignIn } from "./scripted-sign-in.ts";
import { type ProviderSignInRunner, UNAVAILABLE_SIGN_IN } from "./sign-in.ts";

const USER = "00000000-0000-4000-8000-000000000001";
const WEB = "http://localhost:3000";
const NOW = new Date("2026-10-23T09:00:00.000Z");

function app(options: { signIn?: ProviderSignInRunner; anonymous?: boolean } = {}) {
  const accounts = new InMemoryProviderAccountStore();
  const signIn = options.signIn ?? new ScriptedProviderSignIn();
  const instance = new Hono<{ Variables: AuthVariables }>();
  instance.use("*", async (c, next) => {
    c.set("userId", USER);
    c.set("isAnonymous", options.anonymous ?? false);
    await next();
  });
  registerProviderRoutes(instance, { accounts, signIn, webOrigin: WEB, now: () => NOW });
  return { app: instance, accounts };
}

function send(
  instance: Hono<{ Variables: AuthVariables }>,
  method: string,
  path: string,
  body?: unknown,
  origin: string = WEB,
) {
  return instance.request(path, {
    method,
    headers: { origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function create(instance: Hono<{ Variables: AuthVariables }>, driver: "claude" | "codex") {
  const res = await send(instance, "POST", "/providers/accounts", { driver });
  return ProviderAccountViewSchema.parse(await res.json());
}

describe("GET /providers", () => {
  it("lists nothing, and says whether sign-in can run here", async () => {
    const { app: instance } = app({ signIn: UNAVAILABLE_SIGN_IN });

    const res = await instance.request("/providers");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      signInAvailable: false,
      checkedAt: NOW.toISOString(),
      accounts: [],
    });
  });

  it("shows each account with the sign-in running on it", async () => {
    const { app: instance } = app();
    const created = await create(instance, "claude");
    await send(instance, "POST", `/providers/accounts/${created.id}/sign-in`);

    const body = ProviderAccountsSchema.parse(await (await instance.request("/providers")).json());

    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]?.signIn).toMatchObject({
      phase: "waiting",
      interaction: { type: "terminal" },
    });
  });
});

describe("POST /providers/accounts", () => {
  it("adds an account, switched on and signed out", async () => {
    const { app: instance } = app();

    const res = await send(instance, "POST", "/providers/accounts", {
      driver: "codex",
      label: "Work",
    });

    expect(res.status).toBe(201);
    expect(ProviderAccountViewSchema.parse(await res.json())).toMatchObject({
      driver: "codex",
      label: "Work",
      enabled: true,
      auth: { status: "unauthenticated" },
      signIn: null,
    });
  });

  it("refuses a provider Nap cannot run", async () => {
    const { app: instance } = app();

    const res = await send(instance, "POST", "/providers/accounts", { driver: "cursor" });

    expect(res.status).toBe(400);
  });

  it("refuses past the limit, with a code the dialog can explain", async () => {
    const { app: instance } = app();
    for (let index = 0; index < PROVIDER_ACCOUNT_LIMIT; index += 1)
      await send(instance, "POST", "/providers/accounts", { driver: "claude" });

    const res = await send(instance, "POST", "/providers/accounts", { driver: "claude" });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: PROVIDER_ACCOUNT_LIMIT_REACHED });
  });

  it("tells a guest to sign in to Nap first", async () => {
    const { app: instance } = app({ anonymous: true });

    const res = await send(instance, "POST", "/providers/accounts", { driver: "claude" });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: SIGN_IN_REQUIRED });
  });

  it("refuses a change sent from another site", async () => {
    const { app: instance } = app();

    const res = await send(
      instance,
      "POST",
      "/providers/accounts",
      { driver: "claude" },
      "https://evil.example",
    );

    expect(res.status).toBe(403);
  });
});

describe("PATCH /providers/accounts/:accountId", () => {
  it("switches an account off and renames it", async () => {
    const { app: instance } = app();
    const created = await create(instance, "claude");

    const res = await send(instance, "PATCH", `/providers/accounts/${created.id}`, {
      enabled: false,
      label: "Personal",
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ enabled: false, label: "Personal" });
  });

  it("is a 404 for an account that is not this person's", async () => {
    const { app: instance } = app();

    const res = await send(
      instance,
      "PATCH",
      "/providers/accounts/00000000-0000-4000-8000-0000000000aa",
      { enabled: false },
    );

    expect(res.status).toBe(404);
  });
});

describe("DELETE /providers/accounts/:accountId", () => {
  it("removes the account and cancels a sign-in left running on it", async () => {
    const signIn = new ScriptedProviderSignIn();
    const { app: instance, accounts } = app({ signIn });
    const created = await create(instance, "codex");
    await send(instance, "POST", `/providers/accounts/${created.id}/sign-in`);
    const account = await accounts.get(USER, created.id);
    if (account === null) throw new Error("the account was not created");

    const cancel = vi.spyOn(signIn, "cancel");
    const originalSignOut = signIn.signOut.bind(signIn);
    const signOut = vi.spyOn(signIn, "signOut").mockImplementation(async (userId, found) => {
      await expect(signIn.current(userId, found)).resolves.toMatchObject({ phase: "cancelled" });
      await expect(accounts.get(userId, found.id)).resolves.not.toBeNull();
      await originalSignOut(userId, found);
    });
    const remove = vi.spyOn(accounts, "remove");
    const res = await send(instance, "DELETE", `/providers/accounts/${created.id}`);

    expect(signIn.signedOut).toEqual([created.id]);
    expect(cancel).toHaveBeenCalledBefore(signOut);
    expect(signOut).toHaveBeenCalledBefore(remove);
    expect(res.status).toBe(204);
    await expect(accounts.list(USER)).resolves.toEqual([]);
    await expect(signIn.current(USER, account)).resolves.toMatchObject({ phase: "cancelled" });
  });
});

describe("POST /providers/accounts/:accountId/sign-in", () => {
  it("starts the provider's own sign-in", async () => {
    const { app: instance } = app();
    const created = await create(instance, "codex");

    const res = await send(instance, "POST", `/providers/accounts/${created.id}/sign-in`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      signIn: { phase: "waiting", interaction: { type: "browser" } },
    });
  });

  it("says plainly when this deployment cannot sign in", async () => {
    const { app: instance } = app({ signIn: UNAVAILABLE_SIGN_IN });
    const created = await create(instance, "claude");

    const res = await send(instance, "POST", `/providers/accounts/${created.id}/sign-in`);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ code: SIGN_IN_UNAVAILABLE });
  });

  it("refuses to sign in to an account that is switched off", async () => {
    const { app: instance } = app();
    const created = await create(instance, "claude");
    await send(instance, "PATCH", `/providers/accounts/${created.id}`, { enabled: false });

    const res = await send(instance, "POST", `/providers/accounts/${created.id}/sign-in`);

    expect(res.status).toBe(409);
  });
});

describe("DELETE /providers/accounts/:accountId/sign-in", () => {
  it("cancels the running sign-in", async () => {
    const { app: instance } = app();
    const created = await create(instance, "claude");
    await send(instance, "POST", `/providers/accounts/${created.id}/sign-in`);

    const res = await send(instance, "DELETE", `/providers/accounts/${created.id}/sign-in`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ signIn: { phase: "cancelled" } });
  });
});

describe("POST /providers/accounts/:accountId/sign-out", () => {
  it("signs the provider's agent out", async () => {
    const signIn = new ScriptedProviderSignIn();
    const { app: instance } = app({ signIn });
    const created = await create(instance, "claude");

    const res = await send(instance, "POST", `/providers/accounts/${created.id}/sign-out`);

    expect(res.status).toBe(200);
    expect(signIn.signedOut).toEqual([created.id]);
  });
});

const ACCOUNT_ROUTES = [
  { method: "GET", path: "/providers" },
  { method: "POST", path: "/providers/accounts", body: { driver: "claude" } },
  { method: "PATCH", path: "/providers/accounts/:id", body: { label: "Changed", enabled: false } },
  { method: "DELETE", path: "/providers/accounts/:id" },
  { method: "POST", path: "/providers/accounts/:id/sign-in" },
  { method: "DELETE", path: "/providers/accounts/:id/sign-in" },
  { method: "POST", path: "/providers/accounts/:id/sign-out" },
];

describe("provider route guards", () => {
  it.each(ACCOUNT_ROUTES)(
    "refuses a guest on $method $path",
    async ({ method, path, ...input }) => {
      const signIn = new ScriptedProviderSignIn();
      const { app: instance, accounts } = app({ anonymous: true, signIn });
      const account = await accounts.create({ userId: USER, driver: "claude", label: "Work" });
      const before = await accounts.list(USER);
      const res = await send(
        instance,
        method,
        path.replace(":id", account.id),
        "body" in input ? input.body : undefined,
      );
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ code: SIGN_IN_REQUIRED });
      await expect(accounts.list(USER)).resolves.toEqual(before);
      expect(signIn.signedOut).toEqual([]);
      await expect(signIn.current(USER, account)).resolves.toBeNull();
    },
  );

  it.each(ACCOUNT_ROUTES.filter((route) => route.method !== "GET"))(
    "refuses a forged Origin on $method $path without side effects",
    async ({ method, path, ...input }) => {
      const signIn = new ScriptedProviderSignIn();
      const { app: instance, accounts } = app({ signIn });
      const account = await accounts.create({ userId: USER, driver: "claude", label: "Work" });
      const before = await accounts.list(USER);
      const flow = await signIn.start(USER, account);
      const res = await send(
        instance,
        method,
        path.replace(":id", account.id),
        "body" in input ? input.body : undefined,
        "https://evil.example",
      );
      expect(res.status).toBe(403);
      await expect(accounts.list(USER)).resolves.toEqual(before);
      expect(signIn.signedOut).toEqual([]);
      await expect(signIn.current(USER, account)).resolves.toEqual(flow);
    },
  );
});

it("revokes private authorization and pending login generations even when native sign-out is unavailable", async () => {
  const { app: instance, accounts } = app({ signIn: UNAVAILABLE_SIGN_IN });
  const account = await create(instance, "claude");
  await accounts.completeSignIn(USER, account.id, {
    generation: 0,
    credentials: { ciphertext: "sealed", iv: "iv" },
    identity: { email: "verified@example.com", plan: null },
  });
  const response = await send(instance, "POST", `/providers/accounts/${account.id}/sign-out`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ auth: { status: "unauthenticated", email: null } });
  await expect(accounts.authorization(USER, account.id)).resolves.toEqual({
    kind: "disconnected",
    generation: 2,
    version: 2,
  });
});
