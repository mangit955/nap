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

export interface NativeDeliveryCipher {
  seal(scope: NativeDeliveryScope, value: string): SealedProviderCredentials;
  open(
    scope: NativeDeliveryScope,
    value: SealedProviderCredentials,
  ): { ok: true; value: string } | { ok: false; reason: string };
}
