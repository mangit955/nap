import { z } from "zod";

export const StoryChapterSchema = z.enum(["describe", "build", "ready"]);
export type StoryChapter = z.infer<typeof StoryChapterSchema>;
export const STORY_THREAD_IDS = ["finance", "cabins", "launch"] as const;
export const StoryThreadSchema = z.enum(STORY_THREAD_IDS);
export type StoryThreadId = z.infer<typeof StoryThreadSchema>;
export const STORY_THREAD_LABELS: Record<StoryThreadId, string> = {
  finance: "Finance",
  cabins: "Bookings",
  launch: "Launch",
};
export const StoryDemoMessageSchema = z.discriminatedUnion("type", [
  z.object({
    source: z.literal("nap-story-demo"),
    type: z.literal("initialize"),
    threadId: StoryThreadSchema,
    chapter: StoryChapterSchema,
  }),
  z.object({
    source: z.literal("nap-story-demo"),
    type: z.literal("stage"),
    chapter: StoryChapterSchema,
  }),
  z.object({
    source: z.literal("nap-story-demo"),
    type: z.literal("select-thread"),
    threadId: StoryThreadSchema,
  }),
  z.object({
    source: z.literal("nap-story-demo"),
    type: z.literal("thread-selected"),
    threadId: StoryThreadSchema,
    chapter: StoryChapterSchema,
  }),
  z.object({ source: z.literal("nap-story-demo"), type: z.literal("ready") }),
  z.object({ source: z.literal("nap-story-demo"), type: z.literal("build") }),
  z.object({ source: z.literal("nap-story-demo"), type: z.literal("describe") }),
  z.object({ source: z.literal("nap-story-demo"), type: z.literal("interact") }),
]);
export type StoryDemoMessage = z.infer<typeof StoryDemoMessageSchema>;
