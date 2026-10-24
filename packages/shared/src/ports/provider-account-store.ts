/**
 * Where the Claude and ChatGPT accounts somebody connected are listed between visits.
 *
 * Public account reads contain metadata only. Private authorization operations hold sealed
 * credentials; encryption and provider identity verification belong to the authenticated
 * application layer. Never serialize a private authorization through the providers API.
 *
 * Every method takes the owner's id and answers as though rows belonging to anybody else do not
 * exist. A route that forgot to check ownership would therefore still get nothing back, rather
 * than somebody else's account.
 */

import { z } from "zod";
import type {
  ProviderAccount,
  ProviderDriver,
  UpdateProviderAccount,
} from "../provider-accounts-protocol.ts";

export const SealedProviderCredentialsSchema = z.strictObject({
  ciphertext: z.string().min(1),
  iv: z.string().min(1),
});
const revision = { generation: z.int().nonnegative(), version: z.int().nonnegative() };
export const ProviderAuthorizationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("disconnected"), ...revision }),
  z.strictObject({ kind: z.literal("refreshing"), ...revision, expiresAt: z.iso.datetime() }),
  z.strictObject({
    kind: z.literal("reconnect_required"),
    ...revision,
    reason: z.literal("refresh_uncertain"),
  }),
  z.strictObject({
    kind: z.literal("connected"),
    ...revision,
    credentials: SealedProviderCredentialsSchema,
  }),
]);
export type ProviderAuthorization = z.infer<typeof ProviderAuthorizationSchema>;
export type SealedProviderCredentials = z.infer<typeof SealedProviderCredentialsSchema>;
export type ProviderAuthorizationWrite =
  | { kind: "updated"; authorization: ProviderAuthorization }
  | { kind: "missing" | "stale" | "disabled" };
export type ProviderSignInCommit = {
  generation: number;
  credentials: SealedProviderCredentials;
  identity: { email: string | null; plan: string | null };
};
export type ProviderCredentialRefresh = {
  generation: number;
  version: number;
  credentials: SealedProviderCredentials;
};

export type NewProviderAccount = {
  userId: string;
  driver: ProviderDriver;
  label: string | null;
};

export interface ProviderAccountStore {
  /** Oldest first, which is the order the provider list shows them in. */
  list(userId: string): Promise<ProviderAccount[]>;

  /** Null when there is no such account, or it is somebody else's. */
  get(userId: string, id: string): Promise<ProviderAccount | null>;

  /** Switched on, and signed out until the provider says otherwise. */
  create(account: NewProviderAccount): Promise<ProviderAccount>;

  /** Null when there is no such account, or it is somebody else's. */
  update(
    userId: string,
    id: string,
    update: UpdateProviderAccount,
  ): Promise<ProviderAccount | null>;

  /** False when there was nothing of this owner's to remove. */
  remove(userId: string, id: string): Promise<boolean>;

  /** Private ciphertext and fencing revisions. Public get/list intentionally exclude them. */
  authorization(userId: string, id: string): Promise<ProviderAuthorization | null>;

  /** Commit a provider-verified login only if logout or another login has not superseded it. */
  completeSignIn(
    userId: string,
    id: string,
    commit: ProviderSignInCommit,
  ): Promise<ProviderAuthorizationWrite>;

  /** Compare-and-swap persistence only. This cannot reconcile ambiguous provider token rotation. */
  replaceCredentials(
    userId: string,
    id: string,
    refresh: ProviderCredentialRefresh,
  ): Promise<ProviderAuthorizationWrite>;

  /** Advance the account generation even when a pending login has not stored credentials yet. */
  revokeAuthorization(userId: string, id: string): Promise<ProviderAuthorization | null>;
}
