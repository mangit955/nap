import { ClaudeProvider, DEFAULT_MODEL_CONFIG } from "@nap/agent/claude-provider";
import { createModelClient, qualifyModel } from "@nap/agent/model-endpoint";
import type { Env } from "./env.ts";

/**
 * The client this deployment pays for its own model calls with: its platform, and the host
 * `NAP_MODEL_BASE_URL` moves it to.
 *
 * The same Messages API on every platform — only the client and the shape of the model id differ,
 * and nothing above `LLMProvider` can tell which one answered. The env check has already refused
 * to boot without whichever credentials the chosen platform needs. Out of `boot.ts` so a test can
 * watch where its turns actually go: a boot line that names a host the client never calls would
 * be believed.
 *
 * Every turn names its model — a line's version, or the free tier's — so the provider's own
 * default is never what a turn runs on. It is the free model when there is one, so a script that
 * names nothing reaches the same model the deployment would pay for.
 */
export function createDeploymentProvider(
  env: Pick<
    Env,
    | "NAP_PLATFORM"
    | "NAP_FREE_MODEL"
    | "NAP_EFFORT"
    | "NAP_MODEL_BASE_URL"
    | "OPENROUTER_API_KEY"
    | "ANTHROPIC_API_KEY"
  >,
): ClaudeProvider {
  return new ClaudeProvider({
    model: qualifyModel(env.NAP_PLATFORM, env.NAP_FREE_MODEL ?? DEFAULT_MODEL_CONFIG.model),
    effort: env.NAP_EFFORT,
    client: createModelClient({
      platform: env.NAP_PLATFORM,
      baseUrl: env.NAP_MODEL_BASE_URL,
      // From the checked env rather than left to the client to find in `process.env`: the same
      // value at boot, and the one a test can hand it.
      apiKey: env.NAP_PLATFORM === "openrouter" ? env.OPENROUTER_API_KEY : env.ANTHROPIC_API_KEY,
    }),
  });
}
