import { z } from "zod";
import { NativeRunBindingSchema } from "./native-run-store.ts";
import type { SealedProviderCredentials } from "./provider-account-store.ts";

export const NativeDeliveryScopeSchema = z.strictObject({
  kind: z.literal("native_delivery"),
  binding: NativeRunBindingSchema,
  runId: z.uuid(),
  sequence: z.int().positive(),
  rawHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type NativeDeliveryScope = z.infer<typeof NativeDeliveryScopeSchema>;

export const NativeReceiptScopeSchema = z.strictObject({
  kind: z.literal("native_receipt"),
  binding: NativeRunBindingSchema,
  runId: z.uuid(),
});
export const NativeStateScopeSchema = z.discriminatedUnion("kind", [
  NativeDeliveryScopeSchema,
  NativeReceiptScopeSchema,
]);
export type NativeStateScope = z.infer<typeof NativeStateScopeSchema>;

export interface NativeStateCipher {
  seal(scope: NativeStateScope, value: string): SealedProviderCredentials;
  open(
    scope: NativeStateScope,
    value: SealedProviderCredentials,
  ): { ok: true; value: string } | { ok: false; reason: string };
}
