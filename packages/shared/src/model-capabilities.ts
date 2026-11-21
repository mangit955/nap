import { lineOf } from "./model-lines.ts";

/**
 * Exact ids outside every line whose image input has been checked: models a deployment may name
 * for its free tier. A line's versions answer from the line instead (`ModelLine.images`), so a new
 * version is not text-only for want of a row here.
 */
const IMAGE_MODELS = new Set([
  // Free. Read a screenshot inside a tool result through OpenRouter's Messages route, which is
  // the shape the computer tool sends. Its one app test failed — docs/computer-use.md, "A free
  // image model".
  "nvidia/nemotron-3.5-super-vl:free",
]);

/**
 * Whether a turn on this exact model may be sent images. Anything not known to take them is
 * text-only, so an unchecked model is never sent a screenshot it would reject.
 */
export function modelSupportsImages(model: string | undefined): boolean {
  if (model === undefined) return false;
  return lineOf(model)?.images ?? IMAGE_MODELS.has(model);
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
