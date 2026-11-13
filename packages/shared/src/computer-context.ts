import type { LLMMessage, LLMObservationBlock } from "./ports/llm-provider.ts";

/** The newest computer screenshots a request keeps after old ones are cut. */
export const COMPUTER_IMAGES_KEPT = 3;

/**
 * The most computer screenshots a request ever carries. One past it cuts back to
 * {@link COMPUTER_IMAGES_KEPT} in one go.
 *
 * Why there is a gap at all: turning an old screenshot into text rewrites the conversation from
 * that point on, and the cache prices a rewrite at its write rate rather than its read rate. Cut
 * one frame per step and every computer step past the third rewrites the last few steps; cut in
 * batches and that happens once every `HIGH_WATER - KEPT + 1` screenshots, at the price of
 * re-reading a couple more frames from the cache in between.
 *
 * Why it is not larger: the request that cuts can only reuse the cache entry written just before
 * the oldest frame it drops, and the API looks back at most 20 blocks for one. A step adds up to
 * three — its prose, its tool calls, its results — so a cut reaching `HIGH_WATER + 1` steps back
 * stays within 18. One more and a turn with prose on every step would rewrite everything since
 * the turn's previous breakpoint at each cut.
 */
export const COMPUTER_IMAGES_HIGH_WATER = 5;

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
