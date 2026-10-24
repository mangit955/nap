import { z } from "zod";
import { ProviderDriverSchema } from "./provider-accounts-protocol.ts";

/** A durable routing decision, with no credential and no implicit subscription-to-API fallback. */
export const ExecutionTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("api"), model: z.string().min(1), billsToUser: z.boolean() }),
  z.strictObject({
    kind: z.literal("subscription"),
    model: z.string().min(1),
    driver: ProviderDriverSchema,
    accountId: z.uuid(),
    generation: z.int().nonnegative(),
  }),
]);
export type ExecutionTarget = z.infer<typeof ExecutionTargetSchema>;
export type SubscriptionTarget = Extract<ExecutionTarget, { kind: "subscription" }>;
