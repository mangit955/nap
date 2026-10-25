/** The client is bound to one authenticated run; tool arguments cannot select another workspace. */
import { z } from "zod";
import { ToolNameSchema } from "../events.ts";

export const NativeWorkspaceCallSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  tool: ToolNameSchema,
  input: z.record(z.string(), z.unknown()),
});
export type NativeWorkspaceCall = z.infer<typeof NativeWorkspaceCallSchema>;
export const NativeWorkspaceReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    value: z.strictObject({ ok: z.boolean(), output: z.string().max(30_000) }),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({ code: z.enum(["denied", "unavailable", "execution_uncertain"]) }),
  }),
]);
export type NativeWorkspaceReply = z.infer<typeof NativeWorkspaceReplySchema>;
export interface NativeWorkspaceTools {
  /** Never retries an uncertain execution. The gateway journals the call before dispatching it. */
  execute(call: NativeWorkspaceCall, signal: AbortSignal): Promise<NativeWorkspaceReply>;
}
