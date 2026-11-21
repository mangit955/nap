import { LINE_KEYS, type LineKey } from "@nap/shared/model-lines";
import { ModelListSchema } from "@nap/shared/models-protocol";
import type { StoredKeyRecord } from "@nap/shared/ports/user-key-store";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AuthVariables } from "../auth/require-user.ts";
import { type ModelPolicy, resolveTurnAccess } from "../turns/model-access.ts";
import { modelLabel, registerModelRoutes } from "./routes.ts";

const VERSIONS: Partial<Record<LineKey, string>> = {
  sol: "openai/gpt-6.2-sol",
  luna: "openai/gpt-6-luna",
  opus: "anthropic/claude-opus-5.5",
  haiku: "anthropic/claude-haiku-5.5",
  "muse-ember": "meta/muse-ember",
};

function policy(freeModel?: string): ModelPolicy {
  return { versionOf: (line) => VERSIONS[line] ?? null, freeModel, freeEffort: "low" };
}

function key(platform: "openrouter" | "anthropic"): StoredKeyRecord {
  return {
    userId: "user-1",
    platform,
    ciphertext: "sealed",
    iv: "iv",
    hint: "sk-…4f2a",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function list(stored: StoredKeyRecord | null, freeModel?: string) {
  const instance = new Hono<{ Variables: AuthVariables }>();
  // Every guarded route runs behind `requireUser`, which is what would normally set this.
  instance.use("*", async (c, next) => {
    c.set("userId", "user-1");
    c.set("isAnonymous", false);
    await next();
  });
  registerModelRoutes(instance, {
    policy: policy(freeModel),
    isNew: (line) => line === "sol",
    keys: async () => stored,
  });
  const response = await instance.request("/models");
  expect(response.status).toBe(200);
  return ModelListSchema.parse(await response.json());
}

describe("GET /models", () => {
  it("lists all nine lines in picker order, with each one's version, images and efforts", async () => {
    const body = await list(key("openrouter"));
    expect(body.lines.map((line) => line.key)).toEqual(LINE_KEYS);
    expect(body.lines.find((line) => line.key === "sol")).toEqual({
      key: "sol",
      label: "Sol",
      vendor: "openai",
      version: "openai/gpt-6.2-sol",
      isNew: true,
      images: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      available: true,
    });
    expect(body.free).toBeNull();
    expect(body).toMatchObject({ fallback: "sol", effort: "medium" });
  });

  it("keeps a line with no working version in the list, unavailable", async () => {
    const fable = (await list(key("openrouter"))).lines.find((line) => line.key === "fable");
    expect(fable).toMatchObject({ version: null, available: false });
  });

  it("defaults an Anthropic key to Opus and offers it the Claude lines alone", async () => {
    const body = await list(key("anthropic"));
    expect(body.fallback).toBe("opus");
    expect(body.lines.filter((line) => line.available).map((line) => line.key)).toEqual([
      "opus",
      "haiku",
    ]);
  });

  it("offers somebody with no key nothing when the deployment pays for nobody", async () => {
    // A menu with a model ticked that every turn is then refused for would be the picker lying.
    const body = await list(null);
    expect(body.lines.some((line) => line.available)).toBe(false);
    expect(body).toMatchObject({ free: null, fallback: null, key: { configured: false } });
  });

  it("offers somebody with no key the free model, at the deployment's effort", async () => {
    const body = await list(null, "nvidia/nemotron-3.5-super-vl:free");
    expect(body.free).toEqual({
      id: "nvidia/nemotron-3.5-super-vl:free",
      label: "Nemotron 3.5 Super Vl",
      images: true,
    });
    expect(body).toMatchObject({ fallback: "nvidia/nemotron-3.5-super-vl:free", effort: "low" });
  });

  it("names as the default a line that runs, when the key's own default has no version", async () => {
    const instance = new Hono<{ Variables: AuthVariables }>();
    instance.use("*", async (c, next) => {
      c.set("userId", "user-1");
      c.set("isAnonymous", false);
      await next();
    });
    registerModelRoutes(instance, {
      policy: {
        versionOf: (line) => (line === "sol" ? null : (VERSIONS[line] ?? null)),
        freeModel: undefined,
        freeEffort: "low",
      },
      isNew: () => false,
      keys: async () => key("openrouter"),
    });
    const body = ModelListSchema.parse(await (await instance.request("/models")).json());
    expect(body.fallback).toBe("luna");
  });

  it("never answers with anything resembling the key itself", async () => {
    const text = JSON.stringify(await list(key("openrouter")));
    expect(text).not.toContain("sealed");
    expect(text).toContain("sk-…4f2a");
  });

  // The menu and the turn route must say the same thing for every caller, or the picker offers a
  // line every turn is refused for, or hides one a key would run.
  it.each([
    ["no key", null, undefined],
    ["no key, a free tier", null, "x/free:free"],
    ["an OpenRouter key", key("openrouter"), undefined],
    ["an Anthropic key", key("anthropic"), undefined],
  ] as const)("agrees with the turn route about every line, for %s", async (_, stored, free) => {
    const body = await list(stored, free);
    const caller = stored === null ? null : { platform: stored.platform, apiKey: "k" };
    for (const line of body.lines) {
      const access = resolveTurnAccess({ requested: line.key, key: caller, policy: policy(free) });
      expect(line.available, line.key).toBe(access.ok);
    }
    if (body.fallback !== null) {
      const access = resolveTurnAccess({
        requested: body.fallback,
        key: caller,
        policy: policy(free),
      });
      expect(access.ok).toBe(true);
    }
  });
});

describe("modelLabel", () => {
  it("drops the vendor, which distinguishes nothing in a list this short", () => {
    expect(modelLabel("anthropic/claude-opus-5")).toBe("Claude Opus 5");
  });

  it("keeps a version number whole rather than splitting it into words", () => {
    expect(modelLabel("openai/gpt-5.6-luna")).toBe("Gpt 5.6 Luna");
  });

  it("drops the `:free` suffix", () => {
    expect(modelLabel("openai/gpt-oss-20b:free")).toBe("Gpt Oss 20b");
  });
});
