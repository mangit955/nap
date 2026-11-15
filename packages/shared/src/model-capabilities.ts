// Exact IDs keep a newly configured model text-only until its image input is verified.
const IMAGE_MODELS = new Set([
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-sol",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-5",
]);

export function modelSupportsImages(model: string | undefined): boolean {
  return model !== undefined && IMAGE_MODELS.has(model);
}

export const MODEL_MEDIA_UNSUPPORTED =
  "This model cannot use image or video references. Choose a model with image input or remove the attachments.";

/**
 * Whether a model costs nothing to run: OpenRouter's `:free` suffix, the only thing that marks
 * one. A suffix rather than a substring, so `:free-tier-preview` is not free. One answer for
 * everything in the API that offers these to people with no key.
 */
export function isFreeModel(model: string | undefined): boolean {
  return model?.endsWith(":free") === true;
}
