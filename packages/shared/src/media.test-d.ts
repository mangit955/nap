import { expectTypeOf } from "vitest";
import type { mediaBlocks } from "./media.ts";
import type { LLMContentBlock } from "./ports/llm-provider.ts";

expectTypeOf<ReturnType<typeof mediaBlocks>>().toEqualTypeOf<
  Extract<LLMContentBlock, { type: "text" | "image" }>[]
>();
