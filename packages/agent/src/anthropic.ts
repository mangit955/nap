/**
 * Reaching Claude at Anthropic's own API, for somebody who brought an Anthropic key.
 *
 * The mirror of `openrouter.ts`, and much smaller because this is the API the SDK was written
 * for: no namespace to add, and a base URL that is the SDK's own default. The only thing that
 * needs saying is how a model id spelled *this codebase's* way — `anthropic/claude-opus-5`,
 * because everything runs through OpenRouter — becomes the id the first-party API answers to.
 *
 * Clients for this API are built in `model-endpoint.ts`, beside OpenRouter's, so the retry policy
 * and the host are set in one place for both.
 */

/**
 * Anthropic's API root, the SDK's own default, spelled out so a client for somebody's key can pin
 * it: left to the SDK, the host follows `ANTHROPIC_BASE_URL` in the environment.
 */
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** The vendor namespace OpenRouter requires and Anthropic's own API does not have. */
const NAMESPACE = "anthropic/";

/**
 * The first-party model id for a model named the way the rest of the codebase names it.
 *
 * `anthropic/claude-opus-5.5` → `claude-opus-5-5`: the namespace goes, and so does the dot,
 * because Anthropic's own API spells a version with hyphens where OpenRouter uses a dot. Anything
 * else is passed through untouched: an id from another vendor cannot be made valid here by
 * rewriting it, and turning `openai/gpt-6.2-sol` into something Anthropic-shaped would hide a
 * routing mistake that the access rules are supposed to catch first.
 */
export function toDirectAnthropicModel(model: string): string {
  return model.startsWith(NAMESPACE) ? model.slice(NAMESPACE.length).replaceAll(".", "-") : model;
}
