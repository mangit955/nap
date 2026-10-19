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
