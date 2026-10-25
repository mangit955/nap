/** Encrypted provider state is bound to its owner and generation before any payload is returned. */

import {
  NativeDeliveryScopeSchema,
  NativeReceiptScopeSchema,
} from "@nap/shared/ports/native-state-cipher";
import type { SealedProviderCredentials } from "@nap/shared/ports/provider-account-store";
import { ProviderSignInChallengeSchema } from "@nap/shared/ports/provider-sign-in-store";
import { ProviderDriverSchema } from "@nap/shared/provider-accounts-protocol";
import { z } from "zod";
import { type EncryptionKey, type OpenResult, open, seal } from "../account/secret-box.ts";

const owner = { userId: z.uuid(), accountId: z.uuid() };
const scopeSchema = z.discriminatedUnion("kind", [
  NativeDeliveryScopeSchema,
  NativeReceiptScopeSchema,
  z.strictObject({
    kind: z.literal("attempt"),
    ...owner,
    authSessionId: z.uuid(),
    challengeHash: ProviderSignInChallengeSchema,
  }),
  z.strictObject({
    kind: z.literal("authorization"),
    ...owner,
    driver: ProviderDriverSchema,
    generation: z.int().nonnegative(),
  }),
]);
export type ProviderSecretScope = z.infer<typeof scopeSchema>;
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  scope: scopeSchema,
  value: z.string(),
});
type ProviderSecretOpenResult = OpenResult | { ok: false; reason: "scope_mismatch" };

export class ProviderSecretBox {
  constructor(private readonly key: EncryptionKey) {}

  seal(scope: ProviderSecretScope, value: string): SealedProviderCredentials {
    // Context is inside the GCM-authenticated envelope. It is checked before exposing plaintext.
    return seal(JSON.stringify({ version: 1, scope: scopeSchema.parse(scope), value }), this.key);
  }

  open(scope: ProviderSecretScope, secret: SealedProviderCredentials): ProviderSecretOpenResult {
    const expected = scopeSchema.parse(scope);
    const opened = open(secret, this.key);
    if (!opened.ok) return opened;
    let value: unknown;
    try {
      value = JSON.parse(opened.value);
    } catch {
      return { ok: false, reason: "malformed" };
    }
    const envelope = envelopeSchema.safeParse(value);
    if (!envelope.success) return { ok: false, reason: "malformed" };
    if (JSON.stringify(envelope.data.scope) !== JSON.stringify(expected))
      return { ok: false, reason: "scope_mismatch" };
    return { ok: true, value: envelope.data.value };
  }
}
