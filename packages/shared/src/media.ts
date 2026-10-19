import { z } from "zod";
import type { LLMContentBlock } from "./ports/llm-provider.ts";

export const MAX_MEDIA_CHARACTERS = 3_000_000;
export const MAX_ATTACHMENTS = 4;

export const MediaFrameSchema = z.object({
  data: z
    .string()
    .min(4)
    .max(MAX_MEDIA_CHARACTERS)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  mediaType: z.literal("image/jpeg"),
  timestamp: z.number().finite().nonnegative(),
});

export const MediaAttachmentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("image"),
    name: z.string().min(1).max(255),
    frames: z.array(MediaFrameSchema).length(1),
  }),
  z.object({
    kind: z.literal("video"),
    name: z.string().min(1).max(255),
    duration: z.number().finite().positive().max(120),
    frames: z.array(MediaFrameSchema).min(1).max(3),
  }),
]);

export const MediaAttachmentsSchema = z
  .array(MediaAttachmentSchema)
  .max(MAX_ATTACHMENTS)
  .refine(
    (attachments) =>
      attachments.reduce(
        (total, attachment) =>
          total + attachment.frames.reduce((size, frame) => size + frame.data.length, 0),
        0,
      ) <= MAX_MEDIA_CHARACTERS,
    "Attachments are too large. Try fewer or smaller files.",
  );

export type MediaAttachment = z.infer<typeof MediaAttachmentSchema>;

export function mediaBlocks(attachments: readonly MediaAttachment[]): LLMContentBlock[] {
  return attachments.flatMap((attachment) => [
    {
      type: "text",
      text:
        attachment.kind === "video"
          ? `Video reference: ${attachment.name}, ${attachment.duration.toFixed(1)} seconds. Sampled frames follow; audio is not included.`
          : `Image reference: ${attachment.name}`,
    },
    ...attachment.frames.flatMap((frame): LLMContentBlock[] => [
      ...(attachment.kind === "video"
        ? [{ type: "text" as const, text: `Frame at ${frame.timestamp.toFixed(1)}s` }]
        : []),
      { type: "image", mediaType: frame.mediaType, data: frame.data },
    ]),
  ]);
}
