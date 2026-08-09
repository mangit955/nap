import { describe, expect, it } from "vitest";
import { createBedrockClient, toBedrockModel } from "./bedrock.ts";

describe("toBedrockModel", () => {
  it("prefixes a first-party model id", () => {
    expect(toBedrockModel("claude-sonnet-5")).toBe("anthropic.claude-sonnet-5");
  });

  it("leaves an already-prefixed id alone, so composing twice is safe", () => {
    // The harness may hand through an id a user typed with the prefix already on it.
    expect(toBedrockModel("anthropic.claude-opus-5")).toBe("anthropic.claude-opus-5");
  });

  it("is idempotent", () => {
    expect(toBedrockModel(toBedrockModel("claude-opus-5"))).toBe("anthropic.claude-opus-5");
  });
});

describe("createBedrockClient", () => {
  it("exposes the messages surface the provider talks to", () => {
    // The whole reason a platform swap is cheap: this client satisfies the same narrow
    // interface the first-party one does, so nothing above it changes.
    const client = createBedrockClient({ apiKey: "test-key", region: "us-east-1" });

    expect(typeof client.messages.stream).toBe("function");
  });

  it("uses the region it was given", () => {
    const client = createBedrockClient({ apiKey: "test-key", region: "eu-central-1" });

    expect(client.awsRegion).toBe("eu-central-1");
  });

  it("fails loudly at construction when no region can be resolved", () => {
    // Found by running this rather than by reading the types: the SDK throws here rather
    // than at the first request, so a missing region is a startup failure with a clear
    // message instead of a confusing network error mid-turn. Anything constructing this
    // must therefore check for a region first.
    // `delete`, not `= undefined`: assigning undefined stores the *string* "undefined",
    // which the SDK reads as a perfectly good region and the assertion below never fires.
    const saved = { region: process.env.AWS_REGION, fallback: process.env.AWS_DEFAULT_REGION };
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;

    try {
      expect(() => createBedrockClient({ apiKey: "test-key" })).toThrow(/region/i);
    } finally {
      if (saved.region !== undefined) process.env.AWS_REGION = saved.region;
      if (saved.fallback !== undefined) process.env.AWS_DEFAULT_REGION = saved.fallback;
    }
  });
});
