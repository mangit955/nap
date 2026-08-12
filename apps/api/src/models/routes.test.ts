import { ModelListSchema } from "@nap/shared/models-protocol";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AuthVariables } from "../auth/require-user.ts";
import { modelLabel, registerModelRoutes } from "./routes.ts";

function app(allowed: string[], fallback: string) {
  const instance = new Hono<{ Variables: AuthVariables }>();
  registerModelRoutes(instance, { allowed, fallback });
  return instance;
}

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

  it("names the fallback rather than leaving it to be guessed from list order", async () => {
    // The picker has to show a selection before anybody has chosen. Inferring it from position
    // puts the tick against the wrong model the first time the allowlist is reordered.
    const result = await app(["a/one", "b/two"], "b/two").request("/models");

    expect(ModelListSchema.parse(await result.json()).fallback).toBe("b/two");
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
});
