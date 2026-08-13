/**
 * Reaching Claude at Anthropic's own API, for somebody who brought an Anthropic key.
 *
 * The mirror of `openrouter.ts`, and much smaller because this is the API the SDK was written
 * for: no base URL to override, no namespace to add. The only thing that needs saying is how
 * a model id spelled *this codebase's* way — `anthropic/claude-opus-5`, because everything
 * runs through OpenRouter — becomes the id the first-party API answers to.
 *
 * There is no `createAnthropicClient` here on purpose. `ClaudeProvider` already constructs a
 * bare `new Anthropic({ apiKey, maxRetries: 0 })` when nothing is injected, and a factory that
 * did the same thing under a different name would be a second place for the retry policy to
 * be set and then forgotten.
 */

/**
 * The vendor namespace OpenRouter requires and Anthropic's own API does not have.
 *
 * Note the slash: Bedrock namespaces the same models with a *dot* (`anthropic.claude-opus-5`),
 * and that id belongs to a different transport. Stripping only the slash form means a Bedrock
 * id passed here stays wrong and surfaces as a 404, which beats being silently accepted.
 */
const NAMESPACE = "anthropic/";

/**
 * The first-party model id for a model named the way the rest of the codebase names it.
 *
 * `anthropic/claude-opus-5` → `claude-opus-5`. Anything else is passed through untouched: an
 * id from another vendor cannot be made valid here by rewriting it, and turning
 * `openai/gpt-5.6-luna` into something Anthropic-shaped would hide a routing mistake that the
 * model allowlist is supposed to catch first.
 */
export function toDirectAnthropicModel(model: string): string {
  return model.startsWith(NAMESPACE) ? model.slice(NAMESPACE.length) : model;
}
