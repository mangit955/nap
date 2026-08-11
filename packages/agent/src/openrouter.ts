/**
 * Reaching models through OpenRouter. This is the only route this project uses.
 *
 * OpenRouter publishes a *native Anthropic Messages endpoint*, so the Anthropic SDK speaks its
 * own protocol to it: the same `tool_use`/`tool_result` blocks, the same streaming events, the
 * same refusal semantics, the same `cache_control` breakpoints. Only two things change — the
 * base URL and a namespaced model id — and both are confined to this file. `ClaudeProvider`,
 * the agent loop and the event contract above it cannot tell the difference.
 *
 * **The endpoint translates for non-Anthropic models too, and that is measured rather than
 * assumed.** OpenRouter's documentation hedges that the Anthropic endpoint is designed for
 * Anthropic's own models, which reads like a restriction and is not one: a request to
 * `openai/gpt-5.6-luna` comes back as a well-formed `tool_use` block with `stop_reason:
 * "tool_use"`, and — the part that matters — its `usage` is in *Anthropic's* shape, with
 * `cache_read_input_tokens` rather than OpenAI's `prompt_tokens_details.cached_tokens`. That
 * distinction is what keeps `toTokenUsage` honest; the OpenAI-shaped `/chat/completions`
 * endpoint would silently break it, which is the reason nothing here goes near that endpoint.
 *
 * What it costs depends on the model, not on the route. OpenRouter charges each vendor's own
 * rates plus a fee on credit top-ups, so Claude through here is Anthropic's price and buys
 * access rather than savings; the cheap models are cheap because they are cheap models.
 *
 * One OpenRouter specific worth knowing: it routes repeat requests back to the same upstream
 * provider to keep prompt caches warm, which is a small bonus for the breakpoints
 * `claude-provider.ts` sets.
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
const NAMESPACE_SEPARATOR = "/";

export type OpenRouterClientOptions = {
  /** Falls back to `OPENROUTER_API_KEY`. Keys look like `sk-or-…`. */
  apiKey?: string;
};

/**
 * The OpenRouter model id for a model named the way the rest of the codebase names it.
 *
 * A bare name like `claude-sonnet-5` is Anthropic's, because that is how this codebase has
 * always spelled a model. Anything *already* carrying a vendor namespace is passed through
 * untouched — `openai/gpt-5.6-luna` must not become `anthropic/openai/gpt-5.6-luna`, which is
 * a 404 several steps away from the configuration that caused it.
 *
 * Note the separator: OpenRouter namespaces with a slash where Bedrock uses a dot, so an id
 * carrying Bedrock's `anthropic.` prefix is *not* namespaced as far as this is concerned. It
 * belongs to the other transport, and surfacing that as a 404 beats hiding it.
 */
export function toOpenRouterModel(model: string): string {
  return model.includes(NAMESPACE_SEPARATOR) ? model : `${MODEL_PREFIX}${model}`;
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
