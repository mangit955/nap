import { DEFAULT_EFFORT, EFFORTS, MODEL_LINES } from "@nap/shared/model-lines";
import type { FreeChoice, ModelList } from "@nap/shared/models-protocol";

/**
 * A `GET /models` answer for a test: all nine lines on a version, reachable as the key allows, and
 * the free model when one is given. A test server answers with this rather than a hand-written
 * body, so a test never pins a shape the API no longer sends.
 */
export function modelList(
  options: { key?: "openrouter" | "anthropic" | null; free?: FreeChoice } = {},
): ModelList {
  const key = options.key === undefined ? "openrouter" : options.key;
  return {
    lines: MODEL_LINES.map((line) => ({
      key: line.key,
      label: line.label,
      vendor: line.vendor,
      version: `${line.vendor}/${line.key}-1`,
      isNew: false,
      images: line.images,
      efforts: [...EFFORTS],
      available: key === "openrouter" || (key === "anthropic" && line.vendor === "anthropic"),
    })),
    free: key === null ? (options.free ?? null) : null,
    key:
      key === null ? { configured: false } : { configured: true, platform: key, hint: "sk-…4f2a" },
    fallback:
      key === "openrouter" ? "sol" : key === "anthropic" ? "opus" : (options.free?.id ?? null),
    effort: DEFAULT_EFFORT,
  };
}
