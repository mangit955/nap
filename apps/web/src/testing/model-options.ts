import type { ModelOption } from "../chat/model-options.ts";

/** A model option for a test: an available, image-capable OpenAI line unless told otherwise. */
export function modelOption(
  overrides: Partial<ModelOption> & Pick<ModelOption, "id" | "label">,
): ModelOption {
  return {
    vendor: "openai",
    version: null,
    isNew: false,
    images: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    available: true,
    free: false,
    ...overrides,
  };
}
