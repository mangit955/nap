import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ANTHROPIC_BASE_URL } from "./anthropic.ts";
import { ClaudeProvider } from "./claude-provider.ts";
import {
  createClientForKey,
  createModelClient,
  ModelBaseUrlSchema,
  modelRouteFromEnv,
  qualifyModel,
} from "./model-endpoint.ts";
import { OPENROUTER_BASE_URL } from "./openrouter.ts";
import { type MessagesEndpoint, messagesEndpoint } from "./testing/messages-endpoint.ts";

const open: MessagesEndpoint[] = [];
afterEach(async () => {
  for (const endpoint of open.splice(0)) await endpoint.close();
});

async function endpoint(): Promise<MessagesEndpoint> {
  const started = await messagesEndpoint();
  open.push(started);
  return started;
}

/** One turn through the real provider, so the request is the one a turn actually sends. */
async function oneCall(options: Parameters<typeof createModelClient>[0], model: string) {
  const provider = new ClaudeProvider({ model, client: createModelClient(options) });
  await provider.startTurn().complete({
    systemPrompt: "you build apps",
    messages: [{ role: "user", content: "say ok" }],
    tools: [],
  });
}

const base = (url: string) => ModelBaseUrlSchema.parse(url);

describe("createModelClient", () => {
  it("sends an Ollama-style turn to the configured host with the model id untouched", async () => {
    const { url, seen } = await endpoint();

    await oneCall(
      { platform: "anthropic", baseUrl: base(url), apiKey: "ollama" },
      qualifyModel("anthropic", "qwen3.5:9b"),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.path).toBe("/v1/messages");
    // Ollama names its models with a colon and no vendor; a namespace would be a 404 there.
    expect(seen[0]?.body.model).toBe("qwen3.5:9b");
    expect(seen[0]?.headers["x-api-key"]).toBe("ollama");
  });

  it("keeps OpenRouter's namespacing when only the host moves", async () => {
    const { url, seen } = await endpoint();

    await oneCall(
      { platform: "openrouter", baseUrl: base(url), apiKey: "sk-or-test" },
      qualifyModel("openrouter", "claude-sonnet-5"),
    );

    expect(seen[0]?.path).toBe("/v1/messages");
    expect(seen[0]?.body.model).toBe("anthropic/claude-sonnet-5");
  });

  it("keeps a path under the host, for an endpoint mounted below the root", async () => {
    const { url, seen } = await endpoint();

    await oneCall(
      { platform: "anthropic", baseUrl: base(`${url}/proxy/`), apiKey: "k" },
      "claude-sonnet-5",
    );

    expect(seen[0]?.path).toBe("/proxy/v1/messages");
  });

  it("keeps each platform's own host when no base URL is set", () => {
    expect(createModelClient({ platform: "openrouter", apiKey: "sk-or-test" }).baseURL).toBe(
      OPENROUTER_BASE_URL,
    );
    // Whatever the SDK resolves on its own, which is what `ClaudeProvider` gets when handed no
    // client: compared with one built that way rather than spelled out, so the test does not
    // depend on the SDK's default or on an `ANTHROPIC_BASE_URL` in the shell running it.
    expect(createModelClient({ platform: "anthropic", apiKey: "k" }).baseURL).toBe(
      new Anthropic({ apiKey: "k", maxRetries: 0 }).baseURL,
    );
  });

  it("keeps the provider's retry loop the only one", () => {
    for (const platform of ["openrouter", "anthropic"] as const)
      expect(createModelClient({ platform, apiKey: "k" }).maxRetries).toBe(0);
  });
});

describe("ModelBaseUrlSchema", () => {
  it.each([
    "https://openrouter.ai/api",
    "http://localhost:11434",
    "http://localhost:11434/",
    "https://proxy.example.com/anthropic",
  ])("accepts the API root %s", (url) => {
    expect(ModelBaseUrlSchema.safeParse(url).success).toBe(true);
  });

  it.each([
    "http://localhost:11434/v1",
    "http://localhost:11434/v1/",
    "https://openrouter.ai/api/v1",
    "https://api.anthropic.com/v1/messages",
    "http://localhost:11434/V1",
  ])("refuses %s, which the SDK would turn into …/v1/v1/messages", (url) => {
    const parsed = ModelBaseUrlSchema.safeParse(url);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/without \/v1/);
  });

  it.each(["https://user:token@proxy.example.com", "https://user@proxy.example.com/api"])(
    "refuses credentials in %s, which is printed at boot",
    (url) => {
      const parsed = ModelBaseUrlSchema.safeParse(url);
      expect(parsed.error?.issues[0]?.message).toMatch(/username or password/);
    },
  );

  it("accepts an @ in the path, which is not a credential", () => {
    expect(ModelBaseUrlSchema.safeParse("https://proxy.example.com/@team/api").success).toBe(true);
  });

  it.each(["http://localhost:11434?tag=a", "http://localhost:11434#x"])(
    "refuses %s, which the SDK would append /v1/messages after",
    (url) => {
      const parsed = ModelBaseUrlSchema.safeParse(url);
      expect(parsed.error?.issues[0]?.message).toMatch(/query string or fragment/);
    },
  );

  it.each(["localhost:11434", "ftp://example.com", "not a url"])("refuses %s", (url) => {
    expect(ModelBaseUrlSchema.safeParse(url).success).toBe(false);
  });
});

describe("modelRouteFromEnv", () => {
  const OLLAMA = {
    NAP_PLATFORM: "anthropic",
    ANTHROPIC_API_KEY: "ollama",
    NAP_MODEL_BASE_URL: "http://localhost:11434",
  };

  it("builds the client, the model id and the host from the environment", () => {
    const route = modelRouteFromEnv(OLLAMA, { platform: "anthropic", model: "qwen3.5:9b" });

    expect(route.ok).toBe(true);
    if (!route.ok) return;
    expect(route.value.model).toBe("qwen3.5:9b");
    expect(route.value.baseUrl).toBe("http://localhost:11434");
    expect(route.value.client.baseURL).toBe("http://localhost:11434");
    expect(route.value.client.apiKey).toBe("ollama");
  });

  it("keeps the platform's own host when the base URL is unset", () => {
    const route = modelRouteFromEnv(
      { OPENROUTER_API_KEY: "sk-or-test" },
      { platform: "openrouter", model: "claude-sonnet-5" },
    );

    expect(route.ok).toBe(true);
    if (!route.ok) return;
    expect(route.value.baseUrl).toBeUndefined();
    expect(route.value.client.baseURL).toBe(OPENROUTER_BASE_URL);
    expect(route.value.model).toBe("anthropic/claude-sonnet-5");
  });

  it("names the platform's key when it is missing or blank", () => {
    for (const env of [{}, { OPENROUTER_API_KEY: "" }])
      expect(modelRouteFromEnv(env, { platform: "openrouter", model: "m" })).toEqual({
        ok: false,
        error: "OPENROUTER_API_KEY is not set",
      });
    expect(
      modelRouteFromEnv(
        { OPENROUTER_API_KEY: "sk-or-test" },
        { platform: "anthropic", model: "m" },
      ),
    ).toEqual({ ok: false, error: "ANTHROPIC_API_KEY is not set" });
  });

  it("refuses a base URL set up for another platform than the run's", () => {
    // The Ollama recipe in .env.example, run with the harness's default platform.
    const route = modelRouteFromEnv(
      { ...OLLAMA, NAP_PLATFORM: "anthropic", OPENROUTER_API_KEY: "sk-or-test" },
      { platform: "openrouter", model: "openai/gpt-5.6-luna" },
    );
    expect(route).toEqual({
      ok: false,
      error: expect.stringMatching(/NAP_PLATFORM=anthropic.*--platform=anthropic/),
    });
  });

  it("names an unknown NAP_PLATFORM rather than calling it a mismatch", () => {
    const route = modelRouteFromEnv(
      { ...OLLAMA, NAP_PLATFORM: "antropic" },
      { platform: "anthropic", model: "m" },
    );
    expect(route).toEqual({
      ok: false,
      error: "NAP_PLATFORM must be one of openrouter, anthropic",
    });
  });

  it("reads an unset NAP_PLATFORM as OpenRouter, the API's default", () => {
    const env = {
      OPENROUTER_API_KEY: "k",
      ANTHROPIC_API_KEY: "k",
      NAP_MODEL_BASE_URL: "https://proxy.example.com",
    };
    expect(modelRouteFromEnv(env, { platform: "openrouter", model: "m" }).ok).toBe(true);
    expect(modelRouteFromEnv(env, { platform: "anthropic", model: "m" }).ok).toBe(false);
  });

  it("refuses a blank base URL, as the API's boot check does", () => {
    // A script that read `KEY=` as unset would accept a .env the API refuses to boot on.
    const route = modelRouteFromEnv(
      { ...OLLAMA, NAP_MODEL_BASE_URL: "" },
      { platform: "anthropic", model: "m" },
    );
    expect(route.ok).toBe(false);
  });

  it("names the key and the fix when the base URL ends in /v1", () => {
    const route = modelRouteFromEnv(
      { ...OLLAMA, NAP_MODEL_BASE_URL: "http://localhost:11434/v1" },
      { platform: "anthropic", model: "m" },
    );
    expect(route.ok).toBe(false);
    if (!route.ok) expect(route.error).toMatch(/^NAP_MODEL_BASE_URL .*without \/v1/);
  });
});

describe("createClientForKey", () => {
  /** Runs `body` with `ANTHROPIC_BASE_URL` set, as Ollama's instructions tell people to. */
  function withAnthropicBaseUrl(body: () => void): void {
    const before = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "http://operator-host.example:11434";
    try {
      body();
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = before;
    }
  }

  it("sends somebody's Anthropic key to Anthropic whatever the environment says", () => {
    withAnthropicBaseUrl(() => {
      // The SDK alone would follow the variable; the key's own client must not.
      expect(new Anthropic({ apiKey: "k" }).baseURL).toBe("http://operator-host.example:11434");
      expect(createClientForKey({ platform: "anthropic", apiKey: "sk-ant-x" }).baseURL).toBe(
        ANTHROPIC_BASE_URL,
      );
    });
  });

  it("sends somebody's OpenRouter key to OpenRouter whatever the environment says", () => {
    withAnthropicBaseUrl(() => {
      const before = process.env.NAP_MODEL_BASE_URL;
      process.env.NAP_MODEL_BASE_URL = "http://operator-host.example:11434";
      try {
        expect(createClientForKey({ platform: "openrouter", apiKey: "sk-or-x" }).baseURL).toBe(
          OPENROUTER_BASE_URL,
        );
      } finally {
        if (before === undefined) delete process.env.NAP_MODEL_BASE_URL;
        else process.env.NAP_MODEL_BASE_URL = before;
      }
    });
  });

  it("keeps the provider's retry loop the only one", () => {
    for (const platform of ["openrouter", "anthropic"] as const)
      expect(createClientForKey({ platform, apiKey: "k" }).maxRetries).toBe(0);
  });
});

describe("qualifyModel", () => {
  it("namespaces for OpenRouter and leaves Anthropic's spelling verbatim", () => {
    expect(qualifyModel("openrouter", "claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
    expect(qualifyModel("openrouter", "openai/gpt-5.6-luna")).toBe("openai/gpt-5.6-luna");
    expect(qualifyModel("anthropic", "claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(qualifyModel("anthropic", "qwen3.5:9b")).toBe("qwen3.5:9b");
  });
});
