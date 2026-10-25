/** Private checkpoints for native CLI login; public account reads never expose this state. */
import { z } from "zod";
import { SealedProviderCredentialsSchema } from "./provider-account-store.ts";
import type { ProviderSignInOwner, ProviderSignInRefusal } from "./provider-sign-in-store.ts";
import { ProviderSignInChallengeSchema } from "./provider-sign-in-store.ts";

export const ProviderSignInProcessStateSchema = z.strictObject({
  phase: z.enum(["starting", "waiting", "verifying"]),
  version: z.int().nonnegative(),
  generation: z.int().nonnegative(),
  challengeHash: ProviderSignInChallengeSchema,
  state: SealedProviderCredentialsSchema,
});
export type ProviderSignInProcessState = z.infer<typeof ProviderSignInProcessStateSchema>;
type Flow = { owner: ProviderSignInOwner; flowId: string };
export interface ProviderSignInProcessStore {
  /** Requires the same live Nap session and account generation as the original attempt. */
  inspectSignInProcess(
    input: Flow,
  ): Promise<({ kind: "ready" } & ProviderSignInProcessState) | ProviderSignInRefusal>;
  /** Resolving an output callback requires this CAS before the process transport may ACK. */
  checkpointSignInProcess(
    input: Flow & { version: number; state: z.infer<typeof SealedProviderCredentialsSchema> },
  ): Promise<{ kind: "updated"; version: number } | { kind: "conflict" } | ProviderSignInRefusal>;
}
