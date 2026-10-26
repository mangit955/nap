import type { LLMMessage, LLMObservationBlock } from "./ports/llm-provider.ts";

/** Image retention changes content only, so every provider tool exchange stays paired. */
export function pruneComputerImages(
  messages: readonly LLMMessage[],
  keep: 0 | 3 = 3,
): LLMMessage[] {
  let remaining = messages.reduce(
    (count, message) =>
      count +
      (typeof message.content === "string"
        ? 0
        : message.content.reduce(
            (total, block) =>
              total +
              (block.type === "tool_result" && Array.isArray(block.content)
                ? block.content.filter((child) => child.type === "image").length
                : 0),
            0,
          )),
    0,
  );
  return messages.map((message) =>
    typeof message.content === "string"
      ? message
      : {
          ...message,
          content: message.content.map((block) =>
            block.type !== "tool_result" || typeof block.content === "string"
              ? block
              : {
                  ...block,
                  content: block.content.map((child): LLMObservationBlock => {
                    if (child.type !== "image") return child;
                    return remaining-- > keep
                      ? { type: "text", text: "[Earlier computer screenshot omitted]" }
                      : child;
                  }),
                },
          ),
        },
  );
}
