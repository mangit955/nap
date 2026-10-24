/** Managed token exchange only. Native CLI credential mutation needs process termination fencing. */
import { z } from "zod";
import type {
  ProviderAuthorizationWrite,
  SealedProviderCredentials,
} from "./provider-account-store.ts";

export const ProviderRefreshClaimTokenSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .brand<"ProviderRefreshClaimToken">();
export type ProviderRefreshClaimToken = z.infer<typeof ProviderRefreshClaimTokenSchema>;
export const PROVIDER_REFRESH_TTL_MS = 30_000;
type RefreshRevision = { userId: string; accountId: string; generation: number; version: number };
export type ProviderRefreshClaim =
  | {
      kind: "claimed";
      claimToken: ProviderRefreshClaimToken;
      expiresAt: string;
      credentials: SealedProviderCredentials;
    }
  | { kind: "missing" | "disabled" | "stale" | "busy" | "reconnect_required" | "disconnected" };
export interface ProviderRefreshStore {
  /** One owner across workers; an expired claim is never permission to exchange again. */
  claimManagedRefresh(input: RefreshRevision): Promise<ProviderRefreshClaim>;
  finishManagedRefresh(
    input: RefreshRevision & {
      claimToken: ProviderRefreshClaimToken;
      outcome: { kind: "renewed"; credentials: SealedProviderCredentials } | { kind: "uncertain" };
    },
  ): Promise<ProviderAuthorizationWrite>;
}
