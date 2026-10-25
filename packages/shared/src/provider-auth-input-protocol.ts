/** Private, single-use terminal handoff. Never store this payload in chat events or request logs. */
import { z } from "zod";
export const SubmitProviderCodeSchema = z.strictObject({
  flowId: z.uuid(),
  code: z
    .string()
    .trim()
    .min(1)
    .max(16_384)
    .refine((value) => !/[\r\n\0]/.test(value), "Enter one sign-in code."),
});
export type SubmitProviderCode = z.infer<typeof SubmitProviderCodeSchema>;
