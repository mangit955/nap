/**
 * Which model a turn runs on, at what effort, and whose account pays for it.
 *
 * **This is the only thing standing between a stranger with an account and this deployment's
 * bill.** People pick a model line; this decides whether *this caller* may run it, and resolves it
 * to the exact version that will be queued and billed.
 *
 * The rule in one sentence: **the deployment's own key buys nothing unless it names a free model,
 * and then nothing but that model.** By default it names none, so a caller with no key of their
 * own can start nothing. A deployment that wants a free tier sets `NAP_FREE_MODEL`, one exact id
 * rather than a line, which may be a paid model it covers on purpose. Every line needs a key
 * belonging to whoever is asking: an OpenRouter key reaches all of them, an Anthropic key the
 * Claude lines.
 *
 * The models the deployment itself names — `NAP_FALLBACK_MODEL` and `NAP_SUBAGENT_MODEL` — also
 * run on its key, but only inside turns it already pays for, because the agent uses them only on
 * a turn with no credentials. They are never a way for a caller to reach a model this function
 * refused them.
 *
 * A pure function taking everything it needs, so the whole policy is a table in a test rather
 * than a set of branches spread across route handlers. It returns the *resolved* version and
 * effort rather than validating a request in place: a caller that has to remember to apply a
 * default afterwards is a caller that will one day forget.
 */

import {
  DEFAULT_EFFORT,
  type Effort,
  type LineKey,
  LineKeySchema,
  lineByKey,
  lineOf,
  MODEL_LINES,
} from "@nap/shared/model-lines";
import type { ModelCredentials } from "@nap/shared/ports/llm-provider";

/** What is known about the asker: the key they saved, already opened, or nothing. */
export type CallerKey = ModelCredentials | null;

/** What this deployment runs: the lines as the catalog has them now, and its free tier. */
export type ModelPolicy = {
  /** The exact version a line runs on at this moment, or null when no version passes. */
  versionOf(line: LineKey): string | null;
  /**
   * What somebody with no key of their own runs on, paid for by the deployment. One exact id,
   * never a line. Absent means there is no free tier, and somebody with no key is refused.
   */
  freeModel: string | undefined;
  /** The effort free-tier turns run at, `NAP_EFFORT`: the deployment pays, so it decides. */
  freeEffort: Effort;
};

export type TurnAccess =
  | {
      ok: true;
      /** The exact id to run on, always concrete — never left for a caller to default. */
      model: string;
      effort: Effort;
      /** The line it is a version of; null for the free tier's model. */
      line: LineKey | null;
      /** Absent means this deployment pays: the free tier. */
      credentials?: ModelCredentials;
    }
  | {
      ok: false;
      code: "byok_required" | "model_not_allowed" | "model_unavailable";
      message: string;
    };

export type TurnAccessRequest = {
  /**
   * What the caller asked for, if anything: a line key, the free model's exact id, or an exact
   * version a client saved before there were lines, which is read as its line. Absent is the
   * ordinary case.
   */
  requested: string | undefined;
  /** The effort asked for. Absent means the default; ignored on the free tier. */
  effort?: Effort | undefined;
  key: CallerKey;
  policy: ModelPolicy;
};

/**
 * How a refusal is answered over HTTP, in one place because every admitting route answers it.
 *
 * **403 for `byok_required`, 409 for a line with no working version, 400 for the rest.** Naming a
 * line you are not allowed to *pay for* is a permission answer with something to do about it; a
 * line the catalog has nothing usable for right now conflicts with the catalog's state, and picking
 * another line resolves it; naming one that does not exist is a bad request. All are refused before
 * anything is written, so all are 4xx: a browser holds a start it sent for retry only on an answer
 * that might mean it landed, and a 5xx would leave the draft locked on a request that never can.
 * The browser reads the code and offers the key form on the first alone.
 */
export function refusalStatus(code: Extract<TurnAccess, { ok: false }>["code"]): 400 | 403 | 409 {
  if (code === "byok_required") return 403;
  return code === "model_unavailable" ? 409 : 400;
}

/** The line each kind of key runs when the caller names none, while it has a working version. */
const DEFAULT_LINE: Record<ModelCredentials["platform"], LineKey> = {
  openrouter: "sol",
  anthropic: "opus",
};

/**
 * The line a turn naming none runs on: the key's default, or, while that line has no working
 * version, the first line the key reaches that has one. The picker shows this same line as the
 * default, so what it names and what a message runs on cannot differ.
 */
export function defaultLine(platform: ModelCredentials["platform"], policy: ModelPolicy): LineKey {
  const preferred = DEFAULT_LINE[platform];
  if (policy.versionOf(preferred) !== null) return preferred;
  const working = MODEL_LINES.find(
    (line) => reachableWith(line.key, platform) && policy.versionOf(line.key) !== null,
  );
  return working?.key ?? preferred;
}

/**
 * The line a title is written on for each kind of key: the cheap line of each vendor, and one
 * whose versions accept thinking off (`ModelLine.reasoningMayBeRequired`), which a title is asked
 * for with.
 */
const TITLE_LINE: Record<ModelCredentials["platform"], LineKey> = {
  openrouter: "luna",
  anthropic: "haiku",
};

/**
 * Whether a key of this kind can reach this line at all.
 *
 * An Anthropic key is not a smaller OpenRouter key — it reaches Anthropic's catalogue and nothing
 * else, so offering somebody's Anthropic key an OpenAI line produces a 401 from a vendor rather
 * than an answer. Refusing here means the message names the actual problem.
 */
export function reachableWith(line: LineKey, platform: ModelCredentials["platform"]): boolean {
  return platform === "openrouter" || lineByKey(line).vendor === "anthropic";
}

/** The line a request names: a line key, or an exact version of one. */
function requestedLine(requested: string): LineKey | undefined {
  const key = LineKeySchema.safeParse(requested);
  if (key.success) return key.data;
  return lineOf(requested)?.key as LineKey | undefined;
}

export function resolveTurnAccess(request: TurnAccessRequest): TurnAccess {
  const { requested, key, policy } = request;

  // The free model is checked by its exact id first: a deployment may name a version of a line as
  // its free model, and a keyless caller asking for it must reach the free tier, not the line.
  if (key === null) {
    if (policy.freeModel === undefined) {
      return {
        ok: false,
        code: "byok_required",
        message: "This deployment runs on your own API key. Add one to start.",
      };
    }
    if (requested === undefined || requested === policy.freeModel)
      return { ok: true, model: policy.freeModel, effort: policy.freeEffort, line: null };
  }

  const line = requested === undefined ? undefined : requestedLine(requested);
  // Named something that is no line at all. Checked before anything about keys, because it is a
  // malformed request rather than a question of who may spend what — and answering "bring a key"
  // to somebody who named a typo would send them off to fetch a credential that will not help.
  if (requested !== undefined && line === undefined) {
    return {
      ok: false,
      code: "model_not_allowed",
      message: `model must be one of: ${MODEL_LINES.map((each) => each.key).join(", ")}`,
    };
  }

  if (key === null) {
    return {
      ok: false,
      code: "byok_required",
      message: "That model needs your own API key. Add one, or use the free model.",
    };
  }

  const chosen = line ?? defaultLine(key.platform, policy);
  if (!reachableWith(chosen, key.platform)) {
    return {
      ok: false,
      code: "model_not_allowed",
      message: "An Anthropic key can only run the Claude models. Pick one of those.",
    };
  }

  const effort = request.effort ?? DEFAULT_EFFORT;
  if (!lineByKey(chosen).efforts.includes(effort)) {
    return {
      ok: false,
      code: "model_not_allowed",
      message: `${lineByKey(chosen).label} does not offer ${effort} effort.`,
    };
  }

  const model = policy.versionOf(chosen);
  if (model === null) {
    return {
      ok: false,
      code: "model_unavailable",
      message: `${lineByKey(chosen).label} has no working version right now. Pick another model.`,
    };
  }

  return { ok: true, model, effort, line: chosen, credentials: key };
}

/**
 * Who pays for a session title, and on which model (docs/adr/0031 D4): whoever would pay for this
 * caller's turn, on the cheapest line their key reaches — Luna for an OpenRouter key, Haiku for an
 * Anthropic one — or the free model for somebody with no key on a deployment that has a free tier.
 * Null when there is none, and the title is not written — which is always the answer for somebody
 * with no key on a deployment that pays for nobody.
 *
 * Decided by `resolveTurnAccess` with the line named, so the payer is the turn's own rule.
 */
export function resolveTitleAccess(request: {
  key: CallerKey;
  policy: ModelPolicy;
}): { model: string; credentials?: ModelCredentials } | null {
  const { key, policy } = request;
  const access = resolveTurnAccess({
    requested: key === null ? undefined : TITLE_LINE[key.platform],
    key,
    policy,
  });
  if (!access.ok) return null;
  return access.credentials === undefined
    ? { model: access.model }
    : { model: access.model, credentials: access.credentials };
}
