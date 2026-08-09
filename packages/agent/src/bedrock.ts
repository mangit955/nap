/**
 * Reaching the same Claude models through Amazon Bedrock instead of Anthropic directly.
 *
 * This is not a second vendor, and the distinction is the whole reason it is cheap. Bedrock
 * serves the same models over the same Messages API: the same `tool_use`/`tool_result`
 * blocks, the same streaming events, the same refusal semantics, the same usage fields. What
 * changes is how the client is constructed and that model ids carry a provider prefix — so
 * the swap is confined to this file, and the provider, the agent loop and the event contract
 * above it cannot tell the difference. A genuinely different vendor would break all three;
 * see the model-split note in `CLAUDE.md`.
 *
 * Why it exists: billing runs through AWS rather than Anthropic, which makes it a route to
 * the same models when direct API billing is unavailable.
 */

import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";

/** Bedrock namespaces every model by its provider. */
const MODEL_PREFIX = "anthropic.";

export type BedrockClientOptions = {
  /**
   * A Bedrock API key, used as a bearer token.
   *
   * Absent, the SDK falls back to `AWS_BEARER_TOKEN_BEDROCK` and then to the ordinary AWS
   * credential chain — so a machine already configured for AWS needs nothing passed here.
   */
  apiKey?: string;
  /** Falls back to `AWS_REGION`, then `AWS_DEFAULT_REGION`. */
  region?: string;
};

/**
 * The Bedrock model id for a model named the way the rest of the codebase names it.
 *
 * Idempotent, because the id can arrive from a command line where someone has already typed
 * the prefix, and a doubled prefix fails as a confusing 404 rather than as a validation error.
 */
export function toBedrockModel(model: string): string {
  return model.startsWith(MODEL_PREFIX) ? model : `${MODEL_PREFIX}${model}`;
}

/**
 * A Bedrock client shaped like the one `ClaudeProvider` already takes.
 *
 * Returned as the concrete class rather than the narrow interface so a caller can still read
 * back what the SDK resolved — the region in particular, which is otherwise invisible until a
 * request fails somewhere unexpected.
 */
export function createBedrockClient(options: BedrockClientOptions = {}): AnthropicBedrockMantle {
  return new AnthropicBedrockMantle({
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.region === undefined ? {} : { awsRegion: options.region }),
    // Our own retry policy is the only one that runs, exactly as with the direct client.
    maxRetries: 0,
  });
}
