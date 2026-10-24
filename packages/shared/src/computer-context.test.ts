import { describe, expect, it } from "vitest";
import { pruneComputerImages } from "./computer-context.ts";
import type { LLMMessage } from "./ports/llm-provider.ts";

function history(): LLMMessage[] {
  return Array.from({ length: 5 }, (_, i): LLMMessage[] => [
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
  ]).flat();
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
