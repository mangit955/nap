import type { LLMMessage, LLMObservationBlock } from "./ports/llm-provider.ts";

/** The newest computer screenshots a request keeps after old ones are cut. */
export const COMPUTER_IMAGES_KEPT = 3;

/**
 * The most computer screenshots a request ever carries. One past it cuts back to
 * {@link COMPUTER_IMAGES_KEPT} in one go.
 *
 * Why there is a gap at all: a request reads the cache only where an earlier request wrote an
 * entry — the end of each request, and the markers at the start of the turn. Turning an old
 * screenshot into text changes bytes that every in-turn entry covers, so the request that does it
 * reads up to the turn's start and re-writes the whole turn's conversation at the write price.
 * Cut one frame per round and that happens on every computer step past the third; cut in batches
 * and it happens once every `HIGH_WATER - KEPT + 1` screenshots, for the price of re-reading a few
 * more frames from the cache in between.
 *
 * Why six: it is the knee. Against cutting every round it removes over half of what a long run of
 * computer steps is billed for input; each further pair of frames saves a tenth or less on top,
 * while every request carries them, and each one is charged at the image estimate against the
 * context ceiling — a ceiling a cheap turn may set at forty thousand.
 */
export const COMPUTER_IMAGES_HIGH_WATER = 6;

/** Screenshots inside tool results: the only images this module ever removes. */
export function countComputerImages(messages: readonly LLMMessage[]): number {
  return messages.reduce(
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
}

/**
 * Within a turn, after each tool round: nothing until the count passes
 * {@link COMPUTER_IMAGES_HIGH_WATER}, then the oldest down to {@link COMPUTER_IMAGES_KEPT}.
 */
export function pruneComputerImagesInBatches(messages: readonly LLMMessage[]): LLMMessage[] {
  return countComputerImages(messages) > COMPUTER_IMAGES_HIGH_WATER
    ? pruneComputerImages(messages, COMPUTER_IMAGES_KEPT)
    : [...messages];
}

/** Image retention changes content only, so every provider tool exchange stays paired. */
export function pruneComputerImages(
  messages: readonly LLMMessage[],
  keep: 0 | typeof COMPUTER_IMAGES_KEPT = COMPUTER_IMAGES_KEPT,
): LLMMessage[] {
  let remaining = countComputerImages(messages);
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
