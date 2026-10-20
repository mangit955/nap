import { z } from "zod";
import type { NapEvent } from "./events.ts";
import type {
  LLMMessage,
  LLMRequest,
  LLMTurnResult,
  NativeCompaction,
} from "./ports/llm-provider.ts";

export const TokenUsageSchema = z.strictObject({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
});

const ContentBlockSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({
    type: z.literal("image"),
    mediaType: z.literal("image/jpeg"),
    data: z.string(),
  }),
  z.strictObject({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    type: z.literal("tool_result"),
    toolCallId: z.string(),
    content: z.string(),
    isError: z.boolean(),
  }),
]);
export const ContextMessageSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
});

export const CompactionCheckpointSchema = z.strictObject({
  coveredThrough: z.int().nonnegative(),
  summary: z.string().trim().min(1),
  /** The most recent complete tool exchange, already included in the covered event prefix. */
  tail: z.array(ContextMessageSchema).refine((messages) => {
    if (messages.length === 0) return true;
    if (messages.length !== 2) return false;
    const [call, result] = messages;
    if (
      call?.role !== "assistant" ||
      result?.role !== "user" ||
      !Array.isArray(call.content) ||
      !Array.isArray(result.content)
    )
      return false;
    if (
      call.content.some((block) => block.type !== "text" && block.type !== "tool_use") ||
      result.content.some((block) => block.type !== "tool_result")
    )
      return false;
    const calls = call.content.flatMap((block) => (block.type === "tool_use" ? [block.id] : []));
    const results = result.content.flatMap((block) =>
      block.type === "tool_result" ? [block.toolCallId] : [],
    );
    return (
      calls.length > 0 &&
      new Set(calls).size === calls.length &&
      new Set(results).size === results.length &&
      calls.length === results.length &&
      calls.every((id) => results.includes(id))
    );
  }, "Checkpoint tail must contain a complete tool exchange."),
});
export type CompactionCheckpoint = z.infer<typeof CompactionCheckpointSchema>;

export const CompactionResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("api"), checkpoint: CompactionCheckpointSchema }),
  z.strictObject({
    kind: z.literal("native"),
    provider: z.enum(["claude", "codex"]),
    sessionId: z.string().min(1),
    coveredThrough: z.int().nonnegative(),
  }),
]);

/** Includes schemas, message framing and images. It is an estimate, never provider telemetry. */
export function estimateContextTokens(
  request: Pick<LLMRequest, "systemPrompt" | "messages" | "tools">,
): number {
  let chars = request.systemPrompt.length + JSON.stringify(request.tools).length;
  let images = 0;
  for (const message of request.messages) {
    chars += 24;
    if (typeof message.content === "string") chars += message.content.length;
    else
      for (const block of message.content) {
        if (block.type === "image") images += 2_200;
        else chars += JSON.stringify(block).length;
      }
  }
  return Math.ceil(chars / 4) + images;
}

/** Native sessions own their history; API sessions replace only the working message list. */
export type CompactContext = (request: {
  messages: LLMMessage[];
  tools: LLMRequest["tools"];
  systemPrompt: string;
  trigger: "manual" | "automatic";
  complete: (request: LLMRequest) => Promise<LLMTurnResult>;
  native?: NativeCompaction | undefined;
  signal?: AbortSignal | undefined;
}) => Promise<
  { ok: true; messages: LLMMessage[]; contextTokens?: number } | { ok: false; message: string }
>;

/** Only committed API snapshots replace API history. Native markers cannot erase portable events. */
export function latestCheckpoint(events: readonly NapEvent[]): CompactionCheckpoint | undefined {
  let checkpoint: CompactionCheckpoint | undefined;
  for (const event of events) {
    if (event.type === "compaction.completed" && event.payload.result.kind === "api") {
      const candidate = event.payload.result.checkpoint;
      if (
        candidate.coveredThrough < event.seq &&
        candidate.coveredThrough >= (checkpoint?.coveredThrough ?? 0)
      )
        checkpoint = candidate;
    }
  }
  return checkpoint;
}
