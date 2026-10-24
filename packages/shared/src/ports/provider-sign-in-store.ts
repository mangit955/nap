/** Durable provider sign-in state. Only the claim operation returns sealed private state. */
import { z } from "zod";
import type { ProviderSignInInteraction } from "../provider-accounts-protocol.ts";
import { ProviderSignInInteractionSchema } from "../provider-accounts-protocol.ts";
import type { ProviderSignInCommit, SealedProviderCredentials } from "./provider-account-store.ts";

const base = { flowId: z.uuid(), expiresAt: z.iso.datetime() };
const hiddenInteraction = { interaction: z.null(), message: z.null() };
export const ProviderSignInAttemptSchema = z.discriminatedUnion("phase", [
  z.strictObject({ ...base, phase: z.literal("starting"), ...hiddenInteraction }),
  z.strictObject({
    ...base,
    phase: z.literal("waiting"),
    interaction: ProviderSignInInteractionSchema,
    message: z.null(),
  }),
  z.strictObject({ ...base, phase: z.literal("verifying"), ...hiddenInteraction }),
  z.strictObject({ ...base, phase: z.literal("succeeded"), ...hiddenInteraction }),
  z.strictObject({
    ...base,
    phase: z.literal("failed"),
    interaction: z.null(),
    message: z.string().min(1),
  }),
  z.strictObject({
    ...base,
    phase: z.literal("cancelled"),
    interaction: z.null(),
    message: z.string().nullable(),
  }),
]);
export type ProviderSignInAttempt = z.infer<typeof ProviderSignInAttemptSchema>;
export const ProviderSignInChallengeSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .brand<"ProviderSignInChallengeHash">();
export type ProviderSignInChallengeHash = z.infer<typeof ProviderSignInChallengeSchema>;
export const ProviderSignInClaimTokenSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .brand<"ProviderSignInClaimToken">();
export type ProviderSignInClaimToken = z.infer<typeof ProviderSignInClaimTokenSchema>;
export const PROVIDER_SIGN_IN_TTL_MS = 300_000;

/** IDs established by Nap authentication, never by a provider callback or browser request body. */
export type ProviderSignInOwner = { userId: string; authSessionId: string; accountId: string };
type Flow = { owner: ProviderSignInOwner; flowId: string };
export type ProviderSignInRefusal = { kind: "missing" | "disabled" | "stale" | "expired" };
export type ProviderSignInAttemptWrite =
  | { kind: "updated"; attempt: ProviderSignInAttempt }
  | ProviderSignInRefusal;
export type ProviderSignInClaim =
  | {
      kind: "claimed";
      flowId: string;
      accountId: string;
      generation: number;
      /** Private completion capability for the worker that won the callback claim. */
      claimToken: ProviderSignInClaimToken;
      /** Private encrypted PKCE/nonce or runtime state; never put this value in an API response. */
      state: SealedProviderCredentials;
    }
  | ProviderSignInRefusal;
export type ProviderSignInOutcome =
  | {
      kind: "verified";
      claimToken: ProviderSignInClaimToken;
      credentials: SealedProviderCredentials;
      identity: ProviderSignInCommit["identity"];
    }
  | { kind: "failed"; reason: "provider_unavailable" | "verification_failed" };

export interface ProviderSignInStore {
  /** Starts a five-minute attempt and supersedes any other active attempt on this account. */
  beginSignIn(input: {
    owner: ProviderSignInOwner;
    challengeHash: ProviderSignInChallengeHash;
    state: SealedProviderCredentials;
  }): Promise<ProviderSignInAttemptWrite>;
  presentSignIn(
    input: Flow & { interaction: ProviderSignInInteraction; state: SealedProviderCredentials },
  ): Promise<ProviderSignInAttemptWrite>;
  /** Single-use admission to token exchange. A worker crash never puts this back into waiting. */
  claimSignIn(
    input: Flow & { challengeHash: ProviderSignInChallengeHash },
  ): Promise<ProviderSignInClaim>;
  /** Atomically stores provider-verified authorization and consumes the attempt. */
  finishSignIn(
    input: Flow & { outcome: ProviderSignInOutcome },
  ): Promise<ProviderSignInAttemptWrite>;
  cancelSignIn(input: Flow): Promise<ProviderSignInAttemptWrite>;
  /** Interactions are visible only to the Nap session that started them. */
  currentSignIn(owner: ProviderSignInOwner): Promise<ProviderSignInAttempt | null>;
}
