import { type MessagesEndpoint, messagesEndpoint } from "@nap/agent/testing/messages-endpoint";
import { afterEach, describe, expect, it } from "vitest";
import { parseEnv } from "./env.ts";
import { createDeploymentProvider } from "./model-provider.ts";

/**
 * Where the API's own turns go, watched on a loopback endpoint rather than read off the code: the
 * boot line names `NAP_MODEL_BASE_URL` from the env, so only a request shows the client agrees.
 */

const open: MessagesEndpoint[] = [];
afterEach(async () => {
  for (const endpoint of open.splice(0)) await endpoint.close();
});

/** The keys every boot needs, with nothing about the model. */
const BOOTABLE = {
  DATABASE_URL: "postgres://nap:nap@localhost:5432/nap",
  E2B_API_KEY: "e2b_test",
  BETTER_AUTH_SECRET: "a-secret-long-enough-to-sign-a-cookie-with",
  NAP_KEY_ENCRYPTION_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  R2_ACCOUNT_ID: "0123456789abcdef",
  R2_BUCKET: "nap-snapshots",
  R2_ACCESS_KEY_ID: "r2-key",
  R2_SECRET_ACCESS_KEY: "r2-secret",
};

async function oneTurn(env: Record<string, string>) {
  await createDeploymentProvider(parseEnv({ ...BOOTABLE, ...env }))
    .startTurn()
    .complete({
      systemPrompt: "you build apps",
      messages: [{ role: "user", content: "say ok" }],
      tools: [],
    });
}

describe("createDeploymentProvider", () => {
  it("sends the deployment's turns to NAP_MODEL_BASE_URL on the Ollama settings", async () => {
    const endpoint = await messagesEndpoint();
    open.push(endpoint);

    await oneTurn({
      NAP_PLATFORM: "anthropic",
      ANTHROPIC_API_KEY: "ollama",
      NAP_MODEL_BASE_URL: endpoint.url,
      NAP_MODEL: "qwen3.5:9b",
      NAP_ALLOWED_MODELS: "qwen3.5:9b",
    });

    expect(endpoint.seen.map((request) => request.path)).toEqual(["/v1/messages"]);
    expect(endpoint.seen[0]?.body.model).toBe("qwen3.5:9b");
    expect(endpoint.seen[0]?.headers["x-api-key"]).toBe("ollama");
  });

  it("moves an OpenRouter deployment's host and keeps its model spelling", async () => {
    const endpoint = await messagesEndpoint();
    open.push(endpoint);

    await oneTurn({ OPENROUTER_API_KEY: "sk-or-test", NAP_MODEL_BASE_URL: endpoint.url });

    expect(endpoint.seen[0]?.path).toBe("/v1/messages");
    expect(endpoint.seen[0]?.body.model).toBe("openai/gpt-5.6-luna");
    expect(endpoint.seen[0]?.headers["x-api-key"]).toBe("sk-or-test");
  });
});
