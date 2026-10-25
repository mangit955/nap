/** Resolve one requested route; a subscription refusal never enters API billing resolution. */
import { SIGN_IN_REQUIRED } from "@nap/shared/api-error";
import type { ExecutionSelection, ExecutionTarget } from "@nap/shared/execution-target";
import { MODEL_MEDIA_UNSUPPORTED, modelSupportsImages } from "@nap/shared/model-capabilities";
import type { ModelCredentials } from "@nap/shared/ports/llm-provider";
import type { SubscriptionAccessError } from "@nap/shared/ports/subscription-access";
import type { Result } from "@nap/shared/result";
import {
  SUBSCRIPTION_REFUSAL_STATUS,
  type SubscriptionAccess,
} from "../providers/subscription-access.ts";
import { resolveTurnAccess } from "./model-access.ts";
export type ExecutionAccessError =
  | SubscriptionAccessError
  | {
      code: "byok_required" | "execution_selection_required" | typeof SIGN_IN_REQUIRED;
      message: string;
    };
export const EXECUTION_REFUSAL_STATUS = {
  ...SUBSCRIPTION_REFUSAL_STATUS,
  byok_required: 403,
  execution_selection_required: 409,
  [SIGN_IN_REQUIRED]: 403,
} satisfies Record<ExecutionAccessError["code"], 400 | 403 | 404 | 409 | 503>;
type Options = {
  keys?: (userId: string) => Promise<ModelCredentials | null>;
  subscriptions?: SubscriptionAccess;
  allowedModels: readonly string[];
  defaultModel: string;
  freeModel: string;
};
type RequestedChoice =
  | { kind: "explicit"; selection: ExecutionSelection }
  | { kind: "legacy"; model?: string | undefined };
export class ExecutionAccess {
  constructor(private readonly options: Options) {}
  async resolve(input: {
    userId: string;
    isAnonymous: boolean;
    choice: RequestedChoice;
    preference?: ExecutionSelection | undefined;
    hasImages?: boolean;
  }): Promise<Result<ExecutionTarget, ExecutionAccessError>> {
    if (input.choice.kind === "legacy" && input.preference?.kind === "subscription")
      return {
        ok: false,
        error: {
          code: "execution_selection_required",
          message:
            "This conversation uses a subscription. Reload and explicitly select its account or an API model before sending.",
        },
      };
    const selection: ExecutionSelection =
      input.choice.kind === "explicit"
        ? input.choice.selection
        : {
            kind: "api",
            ...(input.choice.model !== undefined
              ? { model: input.choice.model }
              : input.preference?.kind === "api" && input.preference.model !== undefined
                ? { model: input.preference.model }
                : {}),
          };
    if (selection.kind === "subscription") {
      if (input.isAnonymous)
        return {
          ok: false,
          error: { code: SIGN_IN_REQUIRED, message: "Sign in to nap before using a subscription." },
        };
      if (this.options.subscriptions === undefined)
        return {
          ok: false,
          error: {
            code: "subscription_unavailable",
            message: "Subscriptions are unavailable here. No API request was queued.",
          },
        };
      return this.options.subscriptions.resolve({
        userId: input.userId,
        selection,
        ...(input.hasImages === undefined ? {} : { hasImages: input.hasImages }),
      });
    }
    const access = resolveTurnAccess({
      requested: selection.model,
      key: (await this.options.keys?.(input.userId)) ?? null,
      allowed: this.options.allowedModels,
      freeModel: this.options.freeModel,
      defaultModel: this.options.defaultModel,
    });
    if (!access.ok) return { ok: false, error: { code: access.code, message: access.message } };
    if (input.hasImages && !modelSupportsImages(access.model))
      return {
        ok: false,
        error: { code: "model_media_unsupported", message: MODEL_MEDIA_UNSUPPORTED },
      };
    return {
      ok: true,
      value: { kind: "api", model: access.model, billsToUser: access.credentials !== undefined },
    };
  }
}
