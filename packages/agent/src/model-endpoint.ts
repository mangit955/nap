/**
 * Where the deployment's own model calls go, and how the model id is spelled when they get there.
 *
 * Every route this project reaches speaks Anthropic's Messages API, so two independent choices
 * describe one completely. `NAP_PLATFORM` picks the dialect: which key is sent and how a model id
 * is spelled (`openrouter` namespaces it by vendor, `anthropic` leaves it bare). The base URL picks
 * the host. Absent, each platform keeps the host it always had, so a deployment that sets nothing
 * behaves exactly as before. Set, it moves only the host. That is how the same code reaches a
 * local Ollama (`anthropic` dialect, `http://localhost:11434`, a model id like `qwen3.5:9b` that
 * must not be namespaced) or a proxy in front of either vendor.
 *
 * **It moves the deployment's own client and nothing else.** A key somebody saved to their account
 * was checked against its vendor's own API and is billed there, so the client built for it in
 * `claude-provider.ts` never reads this setting. Pointing that key at an operator's endpoint would
 * hand a user's secret to a host they never agreed to.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createOpenRouterClient, toOpenRouterModel } from "./openrouter.ts";

/** The environment key every composition reads the base URL from. */
export const MODEL_BASE_URL_ENV = "NAP_MODEL_BASE_URL";

/** The dialects a deployment's model client can speak. Both are the Messages API. */
export type ModelPlatform = "openrouter" | "anthropic";

/**
 * The API root a model client is pointed at.
 *
 * **A trailing `/v1` is refused, not trimmed.** The SDK appends `/v1/messages` itself, so
 * `…/v1` would request `…/v1/v1/messages` and come back as a 404 that reads like the service is
 * missing. Several vendors document their OpenAI-compatible root with a `/v1` on the end, so the
 * mistake is easy to make, and quietly trimming it would also accept a URL that was meant for a
 * different protocol. Refusing at boot names the key and the fix instead.
 *
 * Branded, so a client can only be handed a URL that has been through this check.
 */
export const ModelBaseUrlSchema = z
  .url({ protocol: /^https?$/, error: "must be an http(s) URL" })
  // Zod runs a refinement even after the URL check failed; an unparseable value has its issue.
  .refine(
    (value) => !URL.canParse(value) || !/\/v1(\/messages)?\/?$/.test(new URL(value).pathname),
    {
      error:
        "must be the API root, without /v1 — the SDK appends /v1/messages itself " +
        "(OpenRouter: https://openrouter.ai/api, Ollama: http://localhost:11434)",
    },
  )
  .brand<"ModelBaseUrl">();

export type ModelBaseUrl = z.infer<typeof ModelBaseUrlSchema>;

/**
 * The base URL from an environment, for the scripts that read one without the API's env schema.
 *
 * Read exactly as the API reads it: unset is absent, and a blank value is refused rather than
 * treated as unset, so a `.env` that boots the API is one the scripts accept and the reverse.
 */
export function readModelBaseUrl(
  env: Record<string, string | undefined>,
): { ok: true; value: ModelBaseUrl | undefined } | { ok: false; error: string } {
  const parsed = ModelBaseUrlSchema.optional().safeParse(env[MODEL_BASE_URL_ENV]);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: `${MODEL_BASE_URL_ENV} ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
  };
}

/** A model id spelled the way `platform` spells it: namespaced for OpenRouter, verbatim otherwise. */
export function qualifyModel(platform: ModelPlatform, model: string): string {
  return platform === "openrouter" ? toOpenRouterModel(model) : model;
}

export type ModelClientOptions = {
  platform: ModelPlatform;
  /** Absent keeps the platform's own host. */
  baseUrl?: ModelBaseUrl | undefined;
  /** Falls back to the platform's key in the environment, as the SDK and `createOpenRouterClient` do. */
  apiKey?: string;
};

/**
 * The deployment's own client for a platform, pointed at `baseUrl` when one is set.
 *
 * For `anthropic` with no base URL this is the client `ClaudeProvider` builds when given none, so
 * passing it changes nothing.
 */
export function createModelClient(options: ModelClientOptions): Anthropic {
  const { platform, baseUrl, apiKey } = options;
  if (platform === "openrouter") {
    return createOpenRouterClient({
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
    });
  }

  // Retries off, as everywhere else: the loop in `ClaudeProvider.complete` is the policy.
  return new Anthropic({
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(baseUrl === undefined ? {} : { baseURL: baseUrl }),
    maxRetries: 0,
  });
}
