import { z } from "zod";

export const TestRecordingStateSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("started") }),
  z.strictObject({
    state: z.literal("available"),
    key: z.string().min(1),
    durationMs: z.int().positive().max(605_000),
    width: z.int().positive().max(1024),
    height: z.int().positive().max(768),
    interrupted: z.boolean(),
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: z.enum(["capture_failed", "timing_failed", "upload_failed", "lease_lost"]),
  }),
]);
export type TestRecordingState = z.infer<typeof TestRecordingStateSchema>;
