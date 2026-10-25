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

/** Includes every field that changes billing or the native account/conversation boundary. */
export function sameExecutionTarget(
  a: ExecutionTarget | undefined,
  b: ExecutionTarget | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.model !== b.model) return false;
  if (a.kind === "api") return b.kind === "api" && a.billsToUser === b.billsToUser;
  return (
    b.kind === "subscription" &&
    a.driver === b.driver &&
    a.accountId === b.accountId &&
    a.generation === b.generation
  );
}

/** User intent. Only the server supplies a billing decision, driver and account generation. */
export const ExecutionSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("api"), model: z.string().min(1).optional() }),
  z.strictObject({
    kind: z.literal("subscription"),
    model: z.string().min(1),
    accountId: z.uuid(),
  }),
]);
export type ExecutionSelection = z.infer<typeof ExecutionSelectionSchema>;

export const ExecutionPreferenceSchema = z.strictObject({
  selection: ExecutionSelectionSchema.nullable(),
});
export type ExecutionPreference = z.infer<typeof ExecutionPreferenceSchema>;
