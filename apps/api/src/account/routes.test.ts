import { InMemoryUserKeyStore } from "@nap/db/testing/in-memory-user-key-store";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../auth/require-user.ts";
import { createKeyVerifier, registerAccountRoutes, type VerifyKey } from "./routes.ts";
import { encryptionKeyFrom, open } from "./secret-box.ts";

const USER = "user-1";
const OPENROUTER = "sk-or-v1-0123456789abcdef0123";
const ANTHROPIC = "sk-ant-api03-0123456789abcdef";
const ENCRYPTION_KEY = encryptionKeyFrom(Buffer.alloc(32, 7).toString("base64"));

function app(options: { verify?: VerifyKey } = {}) {
  const keys = new InMemoryUserKeyStore();
  const instance = new Hono<{ Variables: AuthVariables }>();
  // Every guarded route runs behind `requireUser`, which is what would normally set this.
  instance.use("*", async (c, next) => {
    c.set("userId", USER);
    c.set("isAnonymous", false);
    await next();
  });

  registerAccountRoutes(instance, {
    keys,
    encryptionKey: ENCRYPTION_KEY,
    verify: options.verify ?? (async () => ({ ok: true })),
  });

  return { app: instance, keys };
}

function save(instance: Hono<{ Variables: AuthVariables }>, apiKey: string) {
  return instance.request("/account/api-key", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
}

describe("GET /account/api-key", () => {
  it("says nothing is configured before anybody saves one", async () => {
    const { app: instance } = app();

    const result = await instance.request("/account/api-key");

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ configured: false });
  });

  it("answers with a hint and nothing else", async () => {
    // The temptation is a "show key" affordance for somebody checking what they saved. The
    // answer is that they can paste it again — a key that reads back is a key that leaks
    // through every screen-share, log and browser cache this response passes through.
    //
    // **`toEqual`, not `toMatchObject`, and not a substring check on the body.** An exact
    // shape is the only assertion that catches the realistic regression, which is not somebody
    // adding the plaintext back — the route has never had it — but somebody passing the whole
    // stored row through and shipping the ciphertext and IV to the browser. A `not.toContain`
    // on the plaintext stays green through exactly that.
    const { app: instance } = app();
    await save(instance, OPENROUTER);

    const result = await instance.request("/account/api-key");

    await expect(result.json()).resolves.toEqual({
      configured: true,
      platform: "openrouter",
      hint: "sk-or-…0123",
    });
  });
});

describe("PUT /account/api-key", () => {
  it("stores the key sealed, not in the clear", async () => {
    // The property the whole storage design exists for: a copy of this database, without the
    // encryption secret, holds nothing anybody can spend.
    const { app: instance, keys } = app();

    await save(instance, OPENROUTER);

    const stored = await keys.get(USER);
    expect(stored?.ciphertext).not.toContain("sk-or");
    expect(
      open({ ciphertext: stored?.ciphertext ?? "", iv: stored?.iv ?? "" }, ENCRYPTION_KEY),
    ).toEqual({ ok: true, value: OPENROUTER });
  });

  it("reads the platform off the key rather than being told", async () => {
    const { app: instance, keys } = app();

    await save(instance, ANTHROPIC);

    expect((await keys.get(USER))?.platform).toBe("anthropic");
  });

  it("answers with the same shape GET does, and no key in it", async () => {
    const { app: instance } = app();

    const result = await save(instance, OPENROUTER);

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({
      configured: true,
      platform: "openrouter",
      hint: "sk-or-…0123",
    });
  });

  it("refuses a key from neither vendor without storing anything", async () => {
    const { app: instance, keys } = app();

    const result = await save(instance, "sk-proj-0123456789abcdefghij");

    expect(result.status).toBe(400);
    expect(await keys.get(USER)).toBeNull();
  });

  it("refuses a body with no key at all", async () => {
    const { app: instance } = app();

    const result = await instance.request("/account/api-key", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    expect(result.status).toBe(400);
  });

  it("checks the key against its vendor before storing it", async () => {
    // Otherwise a typo is accepted cheerfully and then fails on every turn, surfacing as "the
    // model is unavailable" three layers from the mistake.
    const verify = vi.fn<VerifyKey>(async () => ({ ok: false, message: "That key was refused." }));
    const { app: instance, keys } = app({ verify });

    const result = await save(instance, OPENROUTER);

    expect(result.status).toBe(400);
    await expect(result.json()).resolves.toMatchObject({ code: "key_rejected" });
    expect(await keys.get(USER)).toBeNull();
  });

  it("replaces a key that was already there", async () => {
    const { app: instance, keys } = app();
    await save(instance, OPENROUTER);

    await save(instance, ANTHROPIC);

    expect((await keys.get(USER))?.platform).toBe("anthropic");
  });
});

describe("DELETE /account/api-key", () => {
  it("forgets the key and says so", async () => {
    const { app: instance, keys } = app();
    await save(instance, OPENROUTER);

    const result = await instance.request("/account/api-key", { method: "DELETE" });

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ configured: false });
    expect(await keys.get(USER)).toBeNull();
  });
});

describe("createKeyVerifier", () => {
  it("accepts a key the vendor recognises", async () => {
    const verify = createKeyVerifier(async () => new Response("{}", { status: 200 }));

    await expect(verify({ platform: "openrouter", apiKey: OPENROUTER })).resolves.toEqual({
      ok: true,
    });
  });

  it("refuses a key the vendor rejects", async () => {
    const verify = createKeyVerifier(async () => new Response("{}", { status: 401 }));

    await expect(verify({ platform: "openrouter", apiKey: OPENROUTER })).resolves.toMatchObject({
      ok: false,
    });
  });

  it("accepts the key when the vendor cannot be reached", async () => {
    // A check that catches typos must not become a gate: nobody should be unable to save a key
    // because OpenRouter is having a bad afternoon. The cost of being wrong here is a turn that
    // fails with the vendor's own message.
    const verify = createKeyVerifier(async () => {
      throw new Error("network down");
    });

    await expect(verify({ platform: "openrouter", apiKey: OPENROUTER })).resolves.toEqual({
      ok: true,
    });
  });

  it("accepts the key when the vendor answers with a fault of its own", async () => {
    const verify = createKeyVerifier(async () => new Response("{}", { status: 503 }));

    await expect(verify({ platform: "openrouter", apiKey: OPENROUTER })).resolves.toEqual({
      ok: true,
    });
  });

  it("sends each vendor the header it actually reads", async () => {
    // Anthropic reads `x-api-key` and OpenRouter a bearer token. Swap them and both answer
    // 401, which this route would report as "that key was refused" — a correct key called bad.
    const calls: { url: string; headers: RequestInit["headers"] }[] = [];
    const verify = createKeyVerifier(async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers });
      return new Response("{}", { status: 200 });
    });

    await verify({ platform: "openrouter", apiKey: OPENROUTER });
    await verify({ platform: "anthropic", apiKey: ANTHROPIC });

    expect(calls[0]?.headers).toMatchObject({ authorization: `Bearer ${OPENROUTER}` });
    expect(calls[1]?.headers).toMatchObject({ "x-api-key": ANTHROPIC });
  });
});
