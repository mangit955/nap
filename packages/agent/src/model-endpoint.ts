/**
 * Where a model call goes, and the model id it carries when it gets there.
 *
 * Every route this project reaches speaks Anthropic's Messages API, so two independent choices
 * describe the deployment's own client completely. The platform (`NAP_PLATFORM`) decides which key
 * is sent and how `NAP_MODEL` is spelled: `openrouter` namespaces it by vendor, `anthropic` leaves
 * it bare. The base URL (`NAP_MODEL_BASE_URL`) decides the host. Absent, each platform keeps the
 * host it always had, so a deployment that sets nothing behaves exactly as before. Set, it moves
 * only the host. That is how the same code reaches a local Ollama (the `anthropic` platform,
 * `http://localhost:11434`, a model id like `qwen3.5:9b` that must not be namespaced) or a proxy
 * in front of either vendor.
 *
 * **It moves the deployment's own client and nothing else.** A key somebody saved to their account
 * was checked against its vendor's own API and is billed there, so `createClientForKey` pins that
 * vendor's host and reads no environment at all. Pointing that key at an operator's endpoint would
 * hand a user's secret to a host they never agreed to.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ModelCredentials } from "@nap/shared/ports/llm-provider";
import { z } from "zod";
import { ANTHROPIC_BASE_URL } from "./anthropic.ts";
import { createOpenRouterClient, toOpenRouterModel } from "./openrouter.ts";

/** The platforms a model client can be built for. Both speak the Messages API. */
export type ModelPlatform = ModelCredentials["platform"];

/** The key each platform authenticates with, read from the environment by the scripts. */
const PLATFORM_KEY: Record<ModelPlatform, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

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
    (value) => !URL.canParse(value) || !/\/v1(\/messages)?\/?$/i.test(new URL(value).pathname),
    {
      error:
        "must be the API root, without /v1 — the SDK appends /v1/messages itself " +
        "(OpenRouter: https://openrouter.ai/api, Ollama: http://localhost:11434)",
    },
  )
  // The SDK appends `/v1/messages` to the end of the string, so a query or fragment would end up in
  // front of it and the request would go to a path nobody configured.
  .refine((value) => !URL.canParse(value) || (!new URL(value).search && !new URL(value).hash), {
    error: "must not have a query string or fragment; the SDK appends /v1/messages to the end",
  })
  // The URL is printed on the boot line and the scripts' banners, so it may not carry a secret.
  .refine(
    (value) => !URL.canParse(value) || !(new URL(value).username || new URL(value).password),
    {
      error: "must not carry a username or password; send credentials as the platform's key",
    },
  )
  .brand<"ModelBaseUrl">();

export type ModelBaseUrl = z.infer<typeof ModelBaseUrlSchema>;

/**
 * The deployment's model id spelled the way `platform` spells it: namespaced for OpenRouter,
 * verbatim otherwise. A model chosen per turn is spelled by `toModelId` in `claude-provider.ts`.
 */
export function qualifyModel(platform: ModelPlatform, model: string): string {
  return platform === "openrouter" ? toOpenRouterModel(model) : model;
}

export type ModelClientOptions = {
  platform: ModelPlatform;
  /** Absent keeps the platform's own host. */
  baseUrl?: ModelBaseUrl | undefined;
  /** Falls back to the platform's key in the environment, as the SDK and OpenRouter's client do. */
  apiKey?: string | undefined;
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

/**
 * A client for a key somebody saved to their own account, always at that key's vendor.
 *
 * The host is pinned rather than left to the SDK, which would otherwise take `ANTHROPIC_BASE_URL`
 * from the environment: Ollama's own instructions tell people to set exactly that, and a
 * deployment that did would send every user's Anthropic key to its own host.
 */
export function createClientForKey(credentials: ModelCredentials): Anthropic {
  return credentials.platform === "openrouter"
    ? // No `baseUrl`: OpenRouter's client defaults to OpenRouter itself and reads no host from the
      // environment.
      createOpenRouterClient({ apiKey: credentials.apiKey })
    : // Retries off, for the reason `ClaudeProvider` gives: its loop in `complete` is the policy.
      new Anthropic({ apiKey: credentials.apiKey, baseURL: ANTHROPIC_BASE_URL, maxRetries: 0 });
}

/** What a script needs to reach the configured endpoint: the client, the model id, and the host. */
export type ModelRoute = {
  client: Anthropic;
  model: string;
  /** For the banner. Absent when the platform's own host is used. */
  baseUrl: ModelBaseUrl | undefined;
};

/**
 * The route a script's real run takes, read from an environment the way the API reads its own.
 *
 * For the compositions that run without the API's env schema — `harness --real`, anything else
 * that drives a turn from a script — so they reach the endpoint a
 * deployment configured with the same `.env` would, and fail before spending on a sandbox when it
 * is misconfigured. Unset is absent; a blank value is refused, as the API refuses it at boot.
 */
export function modelRouteFromEnv(
  env: Record<string, string | undefined>,
  options: { platform: ModelPlatform; model: string },
): { ok: true; value: ModelRoute } | { ok: false; error: string } {
  const keyName = PLATFORM_KEY[options.platform];
  const apiKey = env[keyName];
  if (apiKey === undefined || apiKey === "") return { ok: false, error: `${keyName} is not set` };

  const baseUrl = ModelBaseUrlSchema.optional().safeParse(env.NAP_MODEL_BASE_URL);
  if (!baseUrl.success) {
    const reasons = baseUrl.error.issues.map((issue) => issue.message).join("; ");
    return { ok: false, error: `NAP_MODEL_BASE_URL ${reasons}` };
  }

  // The host belongs to the platform the .env names. A script's platform comes from a flag, so
  // without this an .env set up for Ollama (`NAP_PLATFORM=anthropic`) and a run left on the
  // default `openrouter` would send an OpenRouter key and a namespaced model to that host.
  const configured = env.NAP_PLATFORM ?? "openrouter";
  if (baseUrl.data !== undefined && !(configured in PLATFORM_KEY))
    return {
      ok: false,
      error: `NAP_PLATFORM must be one of ${Object.keys(PLATFORM_KEY).join(", ")}`,
    };
  if (baseUrl.data !== undefined && configured !== options.platform) {
    return {
      ok: false,
      error:
        `NAP_MODEL_BASE_URL is set for NAP_PLATFORM=${configured}, but this run is on ` +
        `${options.platform}; pass --platform=${configured}, or unset NAP_MODEL_BASE_URL`,
    };
  }

  return {
    ok: true,
    value: {
      client: createModelClient({ platform: options.platform, baseUrl: baseUrl.data, apiKey }),
      model: qualifyModel(options.platform, options.model),
      baseUrl: baseUrl.data,
    },
  };
}
