import { describe, expect, it } from "vitest";
import {
  COMPUTER_IMAGES_HIGH_WATER,
  COMPUTER_IMAGES_KEPT,
  countComputerImages,
  pruneComputerImages,
  pruneComputerImagesInBatches,
} from "./computer-context.ts";
import type { LLMMessage } from "./ports/llm-provider.ts";

function history(length = 5): LLMMessage[] {
  return Array.from({ length }, (_, i) => step(i)).flat();
}

/** One computer round trip: the call, and a result carrying one frame. */
function step(i: number): LLMMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `c${i}`,
          name: "computer",
          input: { actions: [{ action: "screenshot" }] },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: `c${i}`,
          isError: false,
          content: [
            { type: "text", text: `screen ${i}` },
            { type: "image", mediaType: "image/jpeg", data: `frame-${i}` },
          ],
        },
      ],
    },
  ];
}

function nestedImages(messages: LLMMessage[]) {
  return messages.flatMap((message) =>
    typeof message.content === "string"
      ? []
      : message.content.flatMap((block) =>
          block.type === "tool_result" && Array.isArray(block.content)
            ? block.content.filter((item) => item.type === "image")
            : [],
        ),
  );
}

describe("computer image retention", () => {
  it("keeps the newest three images without modifying the original transcript or tool pairs", () => {
    const messages = history();
    const original = structuredClone(messages);
    const pruned = pruneComputerImages(messages);
    expect(nestedImages(pruned).map((image) => image.data)).toEqual([
      "frame-2",
      "frame-3",
      "frame-4",
    ]);
    expect(messages).toStrictEqual(original);
    const blocks = pruned.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    );
    expect(blocks.flatMap((block) => (block.type === "tool_use" ? [block.id] : []))).toEqual([
      "c0",
      "c1",
      "c2",
      "c3",
      "c4",
    ]);
    expect(
      blocks.flatMap((block) => (block.type === "tool_result" ? [block.toolCallId] : [])),
    ).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    expect(JSON.stringify(pruned)).toContain("Earlier computer screenshot omitted");
  });

  it("removes all earlier-turn computer images while retaining user reference images", () => {
    const messages = history();
    messages.push({
      role: "user",
      content: [{ type: "image", mediaType: "image/jpeg", data: "user-reference" }],
    });
    const pruned = pruneComputerImages(messages, 0);
    expect(nestedImages(pruned)).toEqual([]);
    expect(JSON.stringify(pruned)).toContain("user-reference");
    expect(JSON.stringify(pruned)).not.toContain("frame-");
    expect(pruneComputerImages(pruned, 0)).toStrictEqual(pruned);
  });
});

describe("computer image retention in batches", () => {
  it("leaves a conversation alone up to the high-water mark", () => {
    const messages = history(COMPUTER_IMAGES_HIGH_WATER);
    expect(pruneComputerImagesInBatches(messages)).toStrictEqual(messages);
  });

  it("cuts back to the kept number in one go once past it", () => {
    const pruned = pruneComputerImagesInBatches(history(COMPUTER_IMAGES_HIGH_WATER + 1));
    expect(nestedImages(pruned).map((image) => image.data)).toEqual(
      Array.from(
        { length: COMPUTER_IMAGES_KEPT },
        (_, i) => `frame-${COMPUTER_IMAGES_HIGH_WATER + 1 - COMPUTER_IMAGES_KEPT + i}`,
      ),
    );
  });

  /**
   * The loop as the agent runs it: append a round trip, prune, send. What one request sent must
   * open the next byte for byte — that is the prefix the cache reads — except at a cut.
   */
  it("rewrites what it already sent only at a cut, and never carries more than the mark", () => {
    const steps = 20;
    let sent: LLMMessage[] = [{ role: "user", content: "Check the page." }];
    const cuts: number[] = [];
    for (let i = 0; i < steps; i += 1) {
      const next = pruneComputerImagesInBatches([...sent, ...step(i)]);
      if (JSON.stringify(next.slice(0, sent.length)) !== JSON.stringify(sent)) cuts.push(i);
      expect(nestedImages(next).length).toBeLessThanOrEqual(COMPUTER_IMAGES_HIGH_WATER);
      // Content only: every call keeps its result, in order.
      const blocks = next.flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      );
      expect(blocks.flatMap((block) => (block.type === "tool_use" ? [block.id] : []))).toEqual(
        blocks.flatMap((block) => (block.type === "tool_result" ? [block.toolCallId] : [])),
      );
      sent = next;
    }
    // The first cut is the frame past the mark; each later one, once the gap has refilled.
    const gap = COMPUTER_IMAGES_HIGH_WATER - COMPUTER_IMAGES_KEPT + 1;
    const expected: number[] = [];
    for (let at = COMPUTER_IMAGES_HIGH_WATER; at < steps; at += gap) expected.push(at);
    expect(cuts).toEqual(expected);
    expect(cuts.length).toBeGreaterThan(1);
  });
});

describe("countComputerImages", () => {
  it("counts screenshots inside tool results and nothing else", () => {
    const messages = history(4);
    messages.push({
      role: "user",
      content: [{ type: "image", mediaType: "image/jpeg", data: "user-reference" }],
    });
    expect(countComputerImages(messages)).toBe(4);
    expect(countComputerImages(pruneComputerImages(messages, 0))).toBe(0);
  });
});
