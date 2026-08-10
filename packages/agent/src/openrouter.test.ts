import { describe, expect, it } from "vitest";
import { createOpenRouterClient, OPENROUTER_BASE_URL, toOpenRouterModel } from "./openrouter.ts";

describe("toOpenRouterModel", () => {
  it("namespaces a model the way the rest of the codebase names it", () => {
    expect(toOpenRouterModel("claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
    expect(toOpenRouterModel("claude-opus-5")).toBe("anthropic/claude-opus-5");
  });

  it("leaves an already-namespaced id alone", () => {
    // The id can arrive from a command line where someone typed the prefix themselves, and a
    // doubled one fails as a confusing 404 rather than as a validation error.
    expect(toOpenRouterModel("anthropic/claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
  });

  it("leaves another vendor's namespace alone rather than claiming it for Anthropic", () => {
    // The default model is one of these. Prefixing it would ask OpenRouter for
    // `anthropic/openai/gpt-5.6-luna` — a 404 that reads like the model was withdrawn.
    expect(toOpenRouterModel("openai/gpt-5.6-luna")).toBe("openai/gpt-5.6-luna");
    expect(toOpenRouterModel("openai/gpt-5.6-terra")).toBe("openai/gpt-5.6-terra");
  });

  it("does not mistake Bedrock's prefix for its own", () => {
    // Bedrock namespaces with a dot, OpenRouter with a slash. Treating one as the other would
    // send `anthropic/anthropic.claude-opus-5`, which is a 404 nobody would read correctly.
    expect(toOpenRouterModel("anthropic.claude-opus-5")).toBe("anthropic/anthropic.claude-opus-5");
  });
});

/**
 * Runs `body` with `OPENROUTER_API_KEY` set to `key`, or absent when it is undefined, and puts
 * the environment back afterwards — so these tests pass on a machine that has the key exported
 * and on one that does not.
 */
function withEnvKey(key: string | undefined, body: () => void): void {
  const before = process.env.OPENROUTER_API_KEY;
  if (key === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = key;

  try {
    body();
  } finally {
    if (before === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = before;
  }
}

describe("createOpenRouterClient", () => {
  it("points the Anthropic SDK at OpenRouter's Anthropic-format endpoint", () => {
    const client = createOpenRouterClient({ apiKey: "sk-or-test" });

    // The SDK appends `/v1/messages` itself, so the base URL stops at the API root. Getting
    // this wrong yields a 404 on a path with `/v1/v1/` in it.
    expect(client.baseURL).toBe(OPENROUTER_BASE_URL);
    expect(OPENROUTER_BASE_URL).not.toMatch(/\/v1\/?$/);
  });

  it("keeps our retry loop the only one that runs", () => {
    // Same reason as the direct client: a second invisible retry loop makes "gives up after N
    // attempts" untestable and triples the real attempt count.
    expect(createOpenRouterClient({ apiKey: "sk-or-test" }).maxRetries).toBe(0);
  });

  it("reads the key from the environment when one is not passed", () => {
    withEnvKey("sk-or-from-env", () => {
      expect(createOpenRouterClient({}).apiKey).toBe("sk-or-from-env");
    });
  });

  it("refuses to construct without a key rather than failing at the first request", () => {
    // Deleted, not assigned `undefined`: assigning it stores the *string* "undefined", which is
    // truthy and made the equivalent Bedrock test pass vacuously the first time it was written.
    withEnvKey(undefined, () => {
      expect(() => createOpenRouterClient({})).toThrow(/OPENROUTER_API_KEY/);
    });
  });
});
