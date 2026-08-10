/**
 * Reaching the same Claude models through OpenRouter instead of Anthropic directly.
 *
 * Like the Bedrock module beside it, this is a *transport*, not a second vendor — and for the
 * same reason it is cheap. OpenRouter publishes a native Anthropic Messages endpoint, so the
 * same SDK speaks the same protocol to it: the same `tool_use`/`tool_result` blocks, the same
 * streaming events, the same refusal semantics, the same `cache_control` breakpoints. Only two
 * things change, the base URL and a namespaced model id, and both are confined to this file.
 * `ClaudeProvider`, the agent loop and the event contract above it cannot tell the difference.
 *
 * Why it exists: it bills an OpenRouter account rather than an Anthropic one, which makes it a
 * route to the same models when direct billing is unavailable. **It is not cheaper.** OpenRouter
 * charges Anthropic's own rates for these models and takes a fee on credit top-ups, so this buys
 * access, not savings — worth being clear about, because the reverse is easy to assume.
 *
 * Two OpenRouter specifics worth knowing:
 *
 *  - The native Anthropic endpoint is guaranteed only for Anthropic's own models. Pointing it at
 *    another vendor's model is not a supported path, and nothing here should learn how.
 *  - OpenRouter routes repeat requests back to the same upstream provider to keep prompt caches
 *    warm, which is a small bonus for the breakpoints `claude-provider.ts` sets.
 */

import Anthropic from "@anthropic-ai/sdk";

/**
 * The API root, not the endpoint.
 *
 * The SDK appends `/v1/messages` itself, so a base URL that already ends in `/v1` produces a
 * request to `/v1/v1/messages` — a 404 that reads like the service is missing rather than like
 * the URL is wrong.
 */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

/** OpenRouter namespaces every model by its vendor, with a slash. */
const MODEL_PREFIX = "anthropic/";

export type OpenRouterClientOptions = {
  /** Falls back to `OPENROUTER_API_KEY`. Keys look like `sk-or-…`. */
  apiKey?: string;
};

/**
 * The OpenRouter model id for a model named the way the rest of the codebase names it.
 *
 * Idempotent, because the id can arrive from a command line where someone has already typed the
 * prefix. Note the separator: OpenRouter uses `anthropic/` where Bedrock uses `anthropic.`, so
 * an id already carrying Bedrock's prefix is *not* treated as namespaced — it belongs to the
 * other transport and passing it here is a mistake worth surfacing as a 404 rather than hiding.
 */
export function toOpenRouterModel(model: string): string {
  return model.startsWith(MODEL_PREFIX) ? model : `${MODEL_PREFIX}${model}`;
}

/**
 * An OpenRouter client shaped like the one `ClaudeProvider` already takes.
 *
 * Returned as the concrete class rather than the narrow interface so a caller can read back what
 * the SDK resolved — the base URL in particular, which is otherwise invisible until a request
 * fails somewhere unexpected.
 */
export function createOpenRouterClient(options: OpenRouterClientOptions = {}): Anthropic {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;

  // Thrown at construction rather than left to the first request. The SDK would otherwise send
  // an unauthenticated call and surface a 401 from somewhere in the agent loop, several steps
  // away from the configuration that is actually missing.
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Put it in apps/api/.env, or pass `apiKey` explicitly.",
    );
  }

  return new Anthropic({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    // Our own retry policy is the only one that runs, exactly as with the direct client.
    maxRetries: 0,
  });
}
