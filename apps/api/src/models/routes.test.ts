import { ModelListSchema } from "@nap/shared/models-protocol";
import type { StoredKeyRecord } from "@nap/shared/ports/user-key-store";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AuthVariables } from "../auth/require-user.ts";
import { modelLabel, registerModelRoutes } from "./routes.ts";

/**
 * A caller with an OpenRouter key, unless told otherwise — which is the case that shows the
 * whole allowlist, and therefore the one most of these assertions are about. The key-less case
 * has its own tests below.
 */
function app(allowed: string[], fallback: string, key: StoredKeyRecord | null = OPENROUTER_KEY) {
  const instance = new Hono<{ Variables: AuthVariables }>();
  // Every guarded route runs behind `requireUser`, which is what would normally set this.
  instance.use("*", async (c, next) => {
    c.set("userId", "user-1");
    c.set("isAnonymous", false);
    await next();
  });
  registerModelRoutes(instance, {
    allowed,
    fallback,
    freeModel: "openai/gpt-oss-20b:free",
    keys: async () => key,
  });
  return instance;
}

const OPENROUTER_KEY: StoredKeyRecord = {
  userId: "user-1",
  platform: "openrouter",
  ciphertext: "sealed",
  iv: "iv",
  hint: "sk-or-…4f2a",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("GET /models", () => {
  it("answers with the deployment's allowlist, in a shape the browser validates", async () => {
    // The same list the turn route enforces. A picker built from anything else offers models
    // that every turn is then refused for naming.
    const instance = app(["openai/gpt-5.6-luna", "anthropic/claude-opus-5"], "openai/gpt-5.6-luna");

    const result = await instance.request("/models");

    expect(result.status).toBe(200);
    const body = ModelListSchema.parse(await result.json());
    expect(body.models.map((model) => model.id)).toEqual([
      "openai/gpt-5.6-luna",
      "anthropic/claude-opus-5",
    ]);
    expect(body.fallback).toBe("openai/gpt-5.6-luna");
  });

  it("says which models cost nothing, so the browser never has to read an id", async () => {
    // The route is the one place that decides. A client that learned to spot `:free` itself
    // would be a second thing to change when the idea of free changes.
    const result = await app(["openai/gpt-oss-20b:free", "anthropic/claude-opus-5"], "x/y").request(
      "/models",
    );

    const body = ModelListSchema.parse(await result.json());
    expect(body.models.map((model) => model.free)).toEqual([true, false]);
  });

  it("names the fallback rather than leaving it to be guessed from list order", async () => {
    // The picker has to show a selection before anybody has chosen. Inferring it from position
    // puts the tick against the wrong model the first time the allowlist is reordered.
    const result = await app(["a/one", "b/two"], "b/two").request("/models");

    expect(ModelListSchema.parse(await result.json()).fallback).toBe("b/two");
  });
});

describe("GET /models, for somebody with no key of their own", () => {
  const ALLOWED = ["openai/gpt-5.6-luna", "anthropic/claude-opus-5", "openai/gpt-oss-20b:free"];

  async function listFor(key: StoredKeyRecord | null) {
    const result = await app(ALLOWED, "openai/gpt-5.6-luna", key).request("/models");
    return ModelListSchema.parse(await result.json());
  }

  it("still lists every model, marking the ones they cannot run", async () => {
    // Marked rather than removed: a menu that silently shortens makes the product look smaller
    // than it is, and gives nobody a way to discover that Opus is one key away.
    const body = await listFor(null);

    expect(body.models.map((model) => model.id)).toEqual(ALLOWED);
    expect(body.models.filter((model) => model.available).map((model) => model.id)).toEqual([
      "openai/gpt-oss-20b:free",
    ]);
  });

  it("falls back to a free model rather than the deployment's paid default", async () => {
    // The tick in the picker has to be on the model a message would really run on, and for
    // somebody with no key that is never `NAP_MODEL`.
    expect((await listFor(null)).fallback).toBe("openai/gpt-oss-20b:free");
  });

  it("says no key is configured", async () => {
    expect((await listFor(null)).key).toEqual({ configured: false });
  });

  it("opens everything once a key is there, and reports it as a hint", async () => {
    const body = await listFor(OPENROUTER_KEY);

    expect(body.models.every((model) => model.available)).toBe(true);
    expect(body.fallback).toBe("openai/gpt-5.6-luna");
    expect(body.key).toEqual({
      configured: true,
      platform: "openrouter",
      hint: "sk-or-…4f2a",
    });
  });

  it("never answers with anything resembling the key itself", async () => {
    // The route reads the *stored* record, which holds ciphertext — so the failure this pins
    // is a future edit that reaches for the opened key to say something about it.
    const body = JSON.stringify(await listFor(OPENROUTER_KEY));

    expect(body).not.toContain("sealed");
    expect(body).not.toContain(OPENROUTER_KEY.ciphertext);
  });

  it("offers an Anthropic key only the Claude models", async () => {
    const body = await listFor({ ...OPENROUTER_KEY, platform: "anthropic", hint: "sk-ant-…9c1d" });

    expect(body.models.filter((model) => model.available).map((model) => model.id)).toEqual([
      "anthropic/claude-opus-5",
    ]);
  });
});

describe("modelLabel", () => {
  it("drops the vendor, which distinguishes nothing in a list this short", () => {
    expect(modelLabel("anthropic/claude-opus-5")).toBe("Claude Opus 5");
  });

  it("keeps a version number whole rather than splitting it into words", () => {
    // `gpt-5.6-luna` is one model. "Gpt 5 6 Luna" reads as a different one, and the label is
    // the only thing in the picker naming what a turn will cost.
    expect(modelLabel("openai/gpt-5.6-luna")).toBe("Gpt 5.6 Luna");
  });

  it("leaves a bare id legible rather than mangled", () => {
    expect(modelLabel("claude-sonnet-5")).toBe("Claude Sonnet 5");
  });

  it("drops the `:free` suffix, which the menu says in words beside it", () => {
    // Left in, the id reads as "Gpt Oss 20b:free" — punctuation in the middle of a product
    // name, saying the same thing as the marker next to it.
    expect(modelLabel("openai/gpt-oss-20b:free")).toBe("Gpt Oss 20b");
  });
});
