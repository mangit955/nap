/**
 * Which model a turn may run on, and whose account pays for it.
 *
 * **This is the only thing standing between a stranger with an account and this deployment's
 * bill.** `NAP_ALLOWED_MODELS` says which models exist; this says which of them *this caller*
 * may reach, and the difference is money. Before it existed, every signed-in person could name
 * `anthropic/claude-opus-5` and the deployment paid for it.
 *
 * The rule in one sentence: **the deployment's own key buys nothing but the freeModel and
 * any :free-suffixed models.** The freeModel is the deployment's explicit demo offering —
 * it may be a paid model the deployment covers intentionally. Anything else needs a key
 * belonging to whoever is asking.
 *
 * A pure function taking everything it needs, so the whole policy is a table in a test rather
 * than a set of branches spread across a route handler. That matters here more than usual —
 * "which of these eleven combinations lets somebody spend my money?" is a question that has to
 * be answerable by reading, not by tracing.
 *
 * It returns the *resolved* model rather than validating one in place. A caller that has to
 * remember to apply a default afterwards is a caller that will one day forget, and forgetting
 * means falling through to `NAP_MODEL`, which is a paid model.
 */

import type { ModelCredentials } from "@nap/shared/ports/llm-provider";

/** What is known about the asker: the key they saved, already opened, or nothing. */
export type CallerKey = ModelCredentials | null;

export type TurnAccess =
  | {
      ok: true;
      /** The id to run on, always concrete — never left for a caller to default. */
      model: string;
      /** Absent means this deployment pays — true for freeModel and :free-suffixed models. */
      credentials?: ModelCredentials;
    }
  | { ok: false; code: "byok_required" | "model_not_allowed"; message: string };

export type TurnAccessRequest = {
  /** What the caller asked for, if anything. Absent is the ordinary case. */
  requested: string | undefined;
  key: CallerKey;
  /** The deployment's allowlist — every model that exists here, free and paid. */
  allowed: readonly string[];
  /** What somebody with no key of their own runs on. The deployment pays for these turns. */
  freeModel: string;
  /** What somebody with a key runs on when they name nothing. */
  defaultModel: string;
};

/** OpenRouter's convention, and the only thing that marks a model as costing nothing. */
export function isFree(model: string): boolean {
  return model.endsWith(":free");
}

/**
 * Whether a key of this kind can reach this model at all.
 *
 * An Anthropic key is not a smaller OpenRouter key — it reaches Anthropic's catalogue and
 * nothing else, so offering somebody's Anthropic key an OpenAI model produces a 401 from a
 * vendor rather than an answer. Refusing here means the message names the actual problem.
 */
function reachableWith(model: string, platform: ModelCredentials["platform"]): boolean {
  return platform === "openrouter" || model.startsWith("anthropic/");
}

/**
 * Every model this caller may name, in the allowlist's order.
 *
 * For a keyless caller, this includes the deployment's `freeModel` (always, regardless of
 * suffix) and any model that carries the `:free` suffix.
 */
export function availableModels(
  allowed: readonly string[],
  key: CallerKey,
  freeModel?: string,
): string[] {
  if (key === null)
    return allowed.filter((model) => model === freeModel || isFree(model));
  return allowed.filter((model) => reachableWith(model, key.platform));
}

export function resolveTurnAccess(request: TurnAccessRequest): TurnAccess {
  const { requested, key, allowed } = request;

  // Named a model that this deployment does not have at all. Checked before anything about
  // keys, because it is a malformed request rather than a question of who may spend what —
  // and answering "bring a key" to somebody who named a typo would send them off to fetch a
  // credential that will not help.
  if (requested !== undefined && !allowed.includes(requested)) {
    return {
      ok: false,
      code: "model_not_allowed",
      message: `model must be one of: ${allowed.join(", ")}`,
    };
  }

  if (key === null) {
    // No key: only the deployment's chosen free model, on the deployment's account.
    // `freeModel` is the deployment's explicit choice and is always reachable, regardless of
    // whether it carries the `:free` suffix — the suffix is OpenRouter's convention, but the
    // deployment may intentionally pay for a non-free model as its demo offering.
    if (requested === undefined) return { ok: true, model: request.freeModel };
    if (requested === request.freeModel || isFree(requested))
      return { ok: true, model: requested };

    return {
      ok: false,
      code: "byok_required",
      message: "That model needs your own API key. Add one, or pick a free model.",
    };
  }

  const model = requested ?? defaultFor(request, key);

  if (!reachableWith(model, key.platform)) {
    return {
      ok: false,
      code: "model_not_allowed",
      message: "An Anthropic key can only run the Claude models. Pick one of those.",
    };
  }

  // A free model still runs on their key rather than ours. It costs them nothing either way,
  // and the alternative is a rule where which account pays depends on which model was picked —
  // which is the kind of thing that is true until somebody reorders a condition.
  return { ok: true, model, credentials: key };
}

/**
 * What to run when somebody with a key names no model.
 *
 * `defaultModel` is `NAP_MODEL`, which is namespaced for OpenRouter — so it is the wrong
 * answer for an Anthropic key, which cannot reach it. Falling back to the first Claude model
 * in the allowlist keeps "just send a message" working for both kinds of key, which is the
 * only thing this needs to do.
 */
function defaultFor(request: TurnAccessRequest, key: ModelCredentials): string {
  if (key.platform === "openrouter") return request.defaultModel;
  return (
    request.allowed.find((model) => model.startsWith("anthropic/")) ??
    // An allowlist with no Claude model in it and an Anthropic key is a configuration nobody
    // has, and the refusal above is a better answer than a guess.
    request.defaultModel
  );
}
