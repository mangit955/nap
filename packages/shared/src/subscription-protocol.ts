/** Public subscription choices describe configured models, never a guaranteed provider entitlement. */
import { z } from "zod";
import { ProviderAccountSchema } from "./provider-accounts-protocol.ts";
export const NativeModelSchema = z.strictObject({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  supportsImages: z.boolean(),
});
export type NativeModel = z.infer<typeof NativeModelSchema>;
export const SubscriptionCatalogSchema = z.strictObject({
  accounts: z.array(
    z.strictObject({
      account: ProviderAccountSchema,
      models: z.array(NativeModelSchema),
      availability: z.enum(["ready", "unavailable", "disabled", "sign_in_required", "refreshing"]),
    }),
  ),
});
export type SubscriptionCatalog = z.infer<typeof SubscriptionCatalogSchema>;
