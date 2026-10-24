/** Private supervisor channel. No frame from this protocol is a public Nap event. */
import { MediaAttachmentsSchema } from "@nap/shared/media";
import {
  NativeWorkspaceCallSchema,
  NativeWorkspaceReplySchema,
} from "@nap/shared/ports/native-workspace-tools";
import { z } from "zod";
import { ClaudeNativeConfigSchema } from "./claude-native-session.ts";

export const ClaudeNativeCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start"),
    runId: z.uuid(),
    config: ClaudeNativeConfigSchema,
    prompt: z.string().min(1).max(131_072),
    attachments: MediaAttachmentsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("tool_reply"),
    id: NativeWorkspaceCallSchema.shape.id,
    reply: NativeWorkspaceReplySchema,
  }),
  z.strictObject({ type: z.literal("cancel") }),
]);
export const ClaudeNativeResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    value: z.strictObject({
      usage: z
        .strictObject({ inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative() })
        .nullable(),
      usageIncomplete: z.literal(true),
    }),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum([
        "subscription_authentication_required",
        "unavailable",
        "protocol_error",
        "cancelled",
        "busy",
        "limit_exceeded",
      ]),
      message: z.string().max(1000),
    }),
  }),
]);
export const ClaudeNativeFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("message"), message: z.unknown() }),
  z.strictObject({ type: z.literal("tool_call"), call: NativeWorkspaceCallSchema }),
  z.strictObject({ type: z.literal("finished"), result: ClaudeNativeResultSchema }),
]);
export type ClaudeNativeFrame = z.infer<typeof ClaudeNativeFrameSchema>;
export type ClaudeNativeCommand = z.infer<typeof ClaudeNativeCommandSchema>;
