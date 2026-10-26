import { z } from "zod";
import { DesktopActionSchema } from "./ports/sandbox-desktop.ts";

export const ComputerAnnotationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("setup"), description: z.string().min(1).max(2000) }),
  z.strictObject({
    type: z.literal("test_start"),
    id: z.string().min(1).max(100),
    description: z.string().min(1).max(2000),
  }),
  z.strictObject({ type: z.literal("action"), description: z.string().min(1).max(2000) }),
  z.strictObject({
    type: z.literal("assertion"),
    id: z.string().min(1).max(100),
    expectation: z.string().min(1).max(2000),
    result: z.enum(["passed", "failed", "untested"]),
  }),
]);
export type ComputerAnnotation = z.infer<typeof ComputerAnnotationSchema>;
export const ComputerActionSchema = z.discriminatedUnion("action", [
  ...DesktopActionSchema.options,
  z.strictObject({ action: z.literal("annotate"), annotation: ComputerAnnotationSchema }),
]);
export type ComputerAction = z.infer<typeof ComputerActionSchema>;
