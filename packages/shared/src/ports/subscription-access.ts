import type { SubscriptionTarget } from "../execution-target.ts";
import type { Result } from "../result.ts";
export type SubscriptionAccessError = {
  code:
    | "subscription_unavailable"
    | "provider_account_missing"
    | "provider_account_disabled"
    | "provider_sign_in_required"
    | "provider_authentication_changed"
    | "provider_refreshing"
    | "model_not_allowed"
    | "model_media_unsupported";
  message: string;
};
export type SubscriptionAuthorizer = (input: {
  userId: string;
  target: SubscriptionTarget;
  hasImages?: boolean;
  phase?: "start" | "continue";
}) => Promise<Result<void, SubscriptionAccessError>>;
