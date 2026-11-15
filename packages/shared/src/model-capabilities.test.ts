import { describe, expect, it } from "vitest";
import { isFreeModel, modelSupportsImages } from "./model-capabilities.ts";

describe("image input policy", () => {
  it.each([
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-sol",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-opus-5",
  ])("allows known image input on %s", (model) => {
    expect(modelSupportsImages(model)).toBe(true);
  });

  it.each([
    undefined,
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "poolside/laguna-s-2.1:free",
    "custom/unknown-model",
    "anthropic/not-a-known-claude",
  ])("keeps unverified image input disabled on %s", (model) => {
    expect(modelSupportsImages(model)).toBe(false);
  });
});

describe("free models", () => {
  it("reads OpenRouter's convention and nothing else", () => {
    expect(isFreeModel("openai/gpt-oss-20b:free")).toBe(true);
    expect(isFreeModel("anthropic/claude-opus-5")).toBe(false);
    // Not a suffix, so not free. A substring match here would make ":free-tier-preview" free.
    expect(isFreeModel("vendor/free-model")).toBe(false);
    expect(isFreeModel("vendor/model:free-tier-preview")).toBe(false);
  });

  it("does not call an unnamed model free", () => {
    expect(isFreeModel(undefined)).toBe(false);
  });
});
