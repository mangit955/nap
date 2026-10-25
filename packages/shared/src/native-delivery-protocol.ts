import { z } from "zod";
import { NativeHostExitReasonSchema } from "./native-process-protocol.ts";
import type { DistributiveOmit, PendingEvent } from "./ports/event-store.ts";

const sequence = z.int().positive().max(2_147_483_647);
/** Private, encrypted frame representation; stdout may end halfway through a UTF-8 character. */
export const NativeStoredFrameSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  frame: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("output"),
      sequence,
      stream: z.enum(["stdout", "stderr"]),
      data: z
        .string()
        .max(349_528)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    }),
    z.strictObject({
      kind: z.literal("exit"),
      sequence,
      code: z.int().nullable(),
      reason: NativeHostExitReasonSchema,
      containment: z.enum(["cgroup", "process_group", "unknown"]),
    }),
  ]),
});

/** The public subset a provider decoder may append with a private delivery receipt. */
export type NativeOutputEvent = DistributiveOmit<
  Extract<
    PendingEvent,
    {
      type:
        | "agent.message"
        | "agent.thinking"
        | "tool.call"
        | "tool.result"
        | "file.changed"
        | "command.output"
        | "context.usage"
        | "system.notice";
    }
  >,
  "createdAt" | "sessionId" | "turnId"
>;
