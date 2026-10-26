import { expect, it } from "vitest";
import {
  CompactionCheckpointSchema,
  ContextMessageSchema,
  estimateContextTokens,
  latestCheckpoint,
} from "./compaction.ts";
import type { NapEventOf } from "./events.ts";

it("counts tool schemas and images as context without treating base64 bytes as text", () => {
  const plain = { systemPrompt: "system", messages: [], tools: [] };
  const base = estimateContextTokens(plain);
  expect(
    estimateContextTokens({
      ...plain,
      tools: [{ name: "tool", description: "long".repeat(100), inputSchema: {} }],
    }),
  ).toBeGreaterThan(base + 100);
  const withImage = (data: string) =>
    estimateContextTokens({
      ...plain,
      messages: [{ role: "user", content: [{ type: "image", mediaType: "image/jpeg", data }] }],
    });
  expect(withImage("abc")).toBe(withImage("x".repeat(10000)));
  expect(withImage("abc")).toBeGreaterThan(base + 2000);
});

it("rejects a checkpoint with an orphan tool call or result at the persistence boundary", () => {
  const checkpoint = { coveredThrough: 2, summary: "summary", tail: [] };
  expect(CompactionCheckpointSchema.safeParse(checkpoint).success).toBe(true);
  expect(
    CompactionCheckpointSchema.safeParse({
      ...checkpoint,
      tail: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "a", name: "read_file", input: {} }],
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    CompactionCheckpointSchema.safeParse({
      ...checkpoint,
      tail: [
        {
          role: "user",
          content: [{ type: "tool_result", toolCallId: "a", content: "result", isError: false }],
        },
      ],
    }).success,
  ).toBe(false);
});

it("ignores future boundaries, regressing checkpoints and native markers during API replay", () => {
  const event = (seq: number, coveredThrough: number): NapEventOf<"compaction.completed"> => ({
    type: "compaction.completed",
    seq,
    sessionId: "s",
    turnId: "t",
    createdAt: "now",
    payload: {
      id: `c${seq}`,
      result: { kind: "api", checkpoint: { coveredThrough, summary: `summary${seq}`, tail: [] } },
      usage: null,
      beforeTokens: null,
      afterTokens: null,
    },
  });
  const native: NapEventOf<"compaction.completed"> = {
    ...event(20, 19),
    payload: {
      ...event(20, 19).payload,
      result: { kind: "native", provider: "codex", sessionId: "native", coveredThrough: 19 },
    },
  };
  expect(latestCheckpoint([event(5, 4), event(8, 100), event(9, 2), native])?.summary).toBe(
    "summary5",
  );
});

it("costs nested tool images independently of their base64 length", () => {
  const cost = (data: string, count: number) =>
    estimateContextTokens({
      systemPrompt: "system",
      tools: [],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: "screen",
              isError: false,
              content: [
                { type: "text", text: "screen" },
                ...Array.from({ length: count }, () => ({
                  type: "image" as const,
                  mediaType: "image/jpeg" as const,
                  data,
                })),
              ],
            },
          ],
        },
      ],
    });
  expect(cost("x".repeat(100000), 1)).toBe(cost("abc", 1));
  expect(cost("abc", 2) - cost("abc", 1)).toBe(2200);
});

it("round-trips block tool results and rejects recursive tools at the context boundary", () => {
  const content = [
    {
      type: "tool_result",
      toolCallId: "screen",
      isError: false,
      content: [
        { type: "text", text: "screen" },
        { type: "image", mediaType: "image/jpeg", data: "/9j/AAAA" },
      ],
    },
  ];
  const message = { role: "user", content };
  expect(ContextMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toStrictEqual(message);
  expect(
    ContextMessageSchema.safeParse({
      role: "user",
      content: [{ type: "tool_result", toolCallId: "screen", isError: false, content }],
    }).success,
  ).toBe(false);
  expect(
    ContextMessageSchema.safeParse({
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "screen",
          isError: false,
          content: [{ type: "image", mediaType: "image/png", data: "bad" }],
        },
      ],
    }).success,
  ).toBe(false);
});
