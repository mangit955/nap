/** Admission and worker checks read current account authorization, never a label or API key. */
import {
  type ExecutionSelection,
  type SubscriptionTarget,
  sameExecutionTarget,
} from "@nap/shared/execution-target";
import type { ProviderAccountStore } from "@nap/shared/ports/provider-account-store";
import type {
  SubscriptionAccessError,
  SubscriptionAuthorizer,
} from "@nap/shared/ports/subscription-access";
import type { ProviderDriver } from "@nap/shared/provider-accounts-protocol";
import type { Result } from "@nap/shared/result";
import {
  type NativeModel,
  NativeModelSchema,
  type SubscriptionCatalog,
} from "@nap/shared/subscription-protocol";
import { z } from "zod";

const messages = {
  subscription_unavailable: "This subscription is not available on this deployment.",
  provider_account_missing: "No such provider account.",
  provider_account_disabled: "Switch this provider account on before using it.",
  provider_sign_in_required: "Sign in to this provider before using its subscription.",
  provider_authentication_changed:
    "This provider account changed after the request was admitted. Select it again.",
  provider_refreshing: "This provider is reconnecting. Try again shortly.",
  model_not_allowed: "This model is not available for the selected provider.",
  model_media_unsupported: "This model does not support these attachments.",
} satisfies Record<SubscriptionAccessError["code"], string>;
export const SUBSCRIPTION_REFUSAL_STATUS = {
  subscription_unavailable: 503,
  provider_account_missing: 404,
  provider_account_disabled: 409,
  provider_sign_in_required: 403,
  provider_authentication_changed: 409,
  provider_refreshing: 409,
  model_not_allowed: 400,
  model_media_unsupported: 400,
} satisfies Record<SubscriptionAccessError["code"], 400 | 403 | 404 | 409 | 503>;
const denied = (code: SubscriptionAccessError["code"]): Result<never, SubscriptionAccessError> => ({
  ok: false,
  error: { code, message: messages[code] },
});

type Options = {
  accounts: ProviderAccountStore;
  /** Derived from installed native adapters. Production passes no provider until its gates pass. */
  providers?: ReadonlyMap<ProviderDriver, readonly NativeModel[]>;
};
export class SubscriptionAccess {
  readonly #accounts: ProviderAccountStore;
  readonly #providers: ReadonlyMap<ProviderDriver, NativeModel[]>;
  constructor(options: Options) {
    this.#accounts = options.accounts;
    const models = z
      .array(NativeModelSchema)
      .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
        message: "Duplicate native model ID",
      });
    this.#providers = new Map(
      [...(options.providers ?? new Map<ProviderDriver, readonly NativeModel[]>())].map(
        ([driver, values]) => [driver, models.parse(values)],
      ),
    );
  }
  async resolve(input: {
    userId: string;
    selection: Extract<ExecutionSelection, { kind: "subscription" }>;
    hasImages?: boolean;
  }): Promise<Result<SubscriptionTarget, SubscriptionAccessError>> {
    return this.#resolve(input, "start");
  }
  async #resolve(
    input: {
      userId: string;
      selection: Extract<ExecutionSelection, { kind: "subscription" }>;
      hasImages?: boolean;
    },
    phase: "start" | "continue",
  ): Promise<Result<SubscriptionTarget, SubscriptionAccessError>> {
    const account = await this.#accounts.get(input.userId, input.selection.accountId);
    if (account === null) return denied("provider_account_missing");
    if (!account.enabled) return denied("provider_account_disabled");
    const models = this.#providers.get(account.driver);
    if (models === undefined) return denied("subscription_unavailable");
    const model = models.find((candidate) => candidate.id === input.selection.model);
    if (model === undefined) return denied("model_not_allowed");
    if (input.hasImages && !model.supportsImages) return denied("model_media_unsupported");
    const authorization = await this.#accounts.authorization(input.userId, account.id);
    if (authorization === null) return denied("provider_account_missing");
    if (authorization.kind === "refreshing" && phase === "start")
      return denied("provider_refreshing");
    if (authorization.kind !== "connected" && authorization.kind !== "refreshing")
      return denied("provider_sign_in_required");
    return {
      ok: true,
      value: {
        kind: "subscription",
        accountId: account.id,
        driver: account.driver,
        model: model.id,
        generation: authorization.generation,
      },
    };
  }
  readonly authorize: SubscriptionAuthorizer = async ({
    userId,
    target,
    hasImages,
    phase = "start",
  }) => {
    const resolved = await this.#resolve(
      {
        userId,
        selection: { kind: "subscription", accountId: target.accountId, model: target.model },
        ...(hasImages === undefined ? {} : { hasImages }),
      },
      phase,
    );
    if (!resolved.ok) return resolved;
    return sameExecutionTarget(resolved.value, target)
      ? { ok: true, value: undefined }
      : denied("provider_authentication_changed");
  };
  async catalog(userId: string): Promise<SubscriptionCatalog> {
    const accounts = await this.#accounts.list(userId);
    return {
      accounts: await Promise.all(
        accounts.map(async (account) => {
          const models = this.#providers.get(account.driver);
          if (!account.enabled)
            return {
              account,
              models: structuredClone(models ?? []),
              availability: "disabled" as const,
            };
          if (models === undefined)
            return { account, models: [], availability: "unavailable" as const };
          const authorization = await this.#accounts.authorization(userId, account.id);
          return {
            account,
            models: structuredClone(models),
            availability:
              authorization?.kind === "connected"
                ? ("ready" as const)
                : authorization?.kind === "refreshing"
                  ? ("refreshing" as const)
                  : ("sign_in_required" as const),
          };
        }),
      ),
    };
  }
}
