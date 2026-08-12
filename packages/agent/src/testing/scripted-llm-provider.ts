/**
 * An `LLMProvider` that returns exactly what a test told it to.
 *
 * Every test of the agent loop needs a model but has no interest in one: what such a test
 * asserts is the *sequence* — which tools ran, in what order, what events came out — and
 * a real model makes that non-deterministic and expensive. Scripting the responses turns
 * those tests into pure functions of their input, which is what lets `docs/PLAN.md` §3
 * keep them in the free suite.
 *
 * The script is a list of turns, each a list of responses handed out in order by
 * successive `complete()` calls. Running past the end of either list **throws**, for the
 * same reason an unscripted `exec` throws in the in-memory sandbox: a test that consumes a
 * response nobody defined is asserting against nothing.
 *
 * Requests are recorded, because the other half of an agent-loop assertion is what the
 * loop *sent* — that a tool's result was fed back, that the system prompt reached the
 * model — and that must be observable without asserting on model prose.
 */

import type {
  LLMProvider,
  LLMRequest,
  LLMToolCall,
  LLMTurn,
  LLMTurnOptions,
  LLMTurnResult,
  TokenUsage,
} from "@nap/shared/ports/llm-provider";

/**
 * One scripted response. Every field is optional and zero-valued, so a test writes only
 * the part it cares about: `{ text: "done" }` for a plain answer, `{ toolCalls: [...] }`
 * for a tool request, `{ refusal: true }` or `{ error }` for the unhappy branches.
 */
export type ScriptedResponse = {
  text?: string;
  toolCalls?: LLMToolCall[];
  usage?: TokenUsage;
  refusal?: boolean;
  error?: { message: string; retryable: boolean };
};

/** The responses one turn hands out, in call order. */
export type ScriptedTurn = ScriptedResponse[];

/** A turn handle that also exposes what it was asked. */
export interface RecordingLLMTurn extends LLMTurn {
  readonly requests: readonly LLMRequest[];
}

const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

function toResult(response: ScriptedResponse): LLMTurnResult {
  const usage = response.usage ?? NO_USAGE;

  if (response.error !== undefined) {
    return {
      type: "error",
      message: response.error.message,
      retryable: response.error.retryable,
      usage,
    };
  }
  if (response.refusal === true) return { type: "refusal", usage };

  return { type: "message", text: response.text ?? "", toolCalls: response.toolCalls ?? [], usage };
}

export class ScriptedLLMProvider implements LLMProvider {
  readonly #turns: ScriptedTurn[];
  #started = 0;
  /** Every request across every turn, in the order they were made. */
  readonly #requests: LLMRequest[] = [];

  constructor(turns: ScriptedTurn[]) {
    this.#turns = turns;
  }

  readonly #turnOptions: LLMTurnOptions[] = [];

  get requests(): readonly LLMRequest[] {
    return this.#requests;
  }

  /** What each turn was started with, so a caller's model choice can be asserted on. */
  get turnOptions(): readonly LLMTurnOptions[] {
    return this.#turnOptions;
  }

  startTurn(options: LLMTurnOptions = {}): RecordingLLMTurn {
    this.#turnOptions.push(options);
    const script = this.#turns[this.#started];
    if (script === undefined) {
      throw new Error(
        `ScriptedLLMProvider: turn ${this.#started + 1} was started but only ${this.#turns.length} turn(s) were scripted`,
      );
    }
    this.#started += 1;

    return new ScriptedTurnHandle(script, this.#started, this.#requests);
  }
}

class ScriptedTurnHandle implements RecordingLLMTurn {
  readonly #script: ScriptedTurn;
  readonly #turnNumber: number;
  /** Shared with the provider so `provider.requests` sees every turn's traffic. */
  readonly #allRequests: LLMRequest[];
  readonly #requests: LLMRequest[] = [];
  #consumed = 0;
  #usage: TokenUsage = NO_USAGE;

  constructor(script: ScriptedTurn, turnNumber: number, allRequests: LLMRequest[]) {
    this.#script = script;
    this.#turnNumber = turnNumber;
    this.#allRequests = allRequests;
  }

  get requests(): readonly LLMRequest[] {
    return this.#requests;
  }

  async complete(request: LLMRequest): Promise<LLMTurnResult> {
    const response = this.#script[this.#consumed];
    if (response === undefined) {
      throw new Error(
        `ScriptedLLMProvider: turn ${this.#turnNumber}'s script is exhausted after ${this.#script.length} response(s), but complete() was called again`,
      );
    }
    this.#consumed += 1;
    this.#requests.push(request);
    this.#allRequests.push(request);

    const result = toResult(response);
    this.#usage = {
      inputTokens: this.#usage.inputTokens + result.usage.inputTokens,
      outputTokens: this.#usage.outputTokens + result.usage.outputTokens,
    };
    return result;
  }

  usage(): TokenUsage {
    return this.#usage;
  }
}
