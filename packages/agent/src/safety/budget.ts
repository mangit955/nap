/**
 * What one turn is allowed to spend.
 *
 * A model that misreads a build error can ask for the same tool forever, and nothing in the
 * loop notices: every individual round trip looks reasonable. The cost of that is real money
 * and a chat pane that never finishes, so a turn carries a ceiling on both round trips and
 * tokens.
 *
 * The verdict carries the `turn.failed` payload rather than a flag, because there is exactly
 * one thing a caller does when a budget runs out and re-deriving the reason at each call site
 * is how two of them end up disagreeing. Whoever drives the loop emits what it is handed.
 *
 * Deciding *when* to check is deliberately not this object's business: a check is cheap, but
 * a turn killed in the middle of a tool batch leaves tool calls unanswered, so the loop looks
 * at its own boundaries.
 */

import type { TurnFailureReason } from "@nap/shared/events";
import type { TokenUsage } from "@nap/shared/ports/llm-provider";

/**
 * Round trips through the model in one turn.
 *
 * High enough that a genuine multi-file feature — read a few files, write them, run the
 * build, fix what it says — never touches it; low enough that a loop costs a minute and not
 * an afternoon.
 */
export const DEFAULT_MAX_STEPS = 40;

/**
 * Tokens across the whole turn, input and output.
 *
 * Several times the context budget rather than equal to it: the context engine caps what one
 * request may carry, and a turn is many requests. This is the ceiling on their sum.
 */
export const DEFAULT_MAX_TOKENS = 400_000;

/** Exactly the `turn.failed` payload, so the caller has nothing left to construct. */
export type TurnFailure = {
  reason: TurnFailureReason;
  message: string;
};

export type BudgetVerdict = { ok: true } | { ok: false; failure: TurnFailure };

export type TurnBudgetOptions = {
  maxSteps?: number;
  maxTokens?: number;
};

export class TurnBudget {
  readonly #maxSteps: number;
  readonly #maxTokens: number;
  #steps = 0;
  #tokens = 0;

  constructor(options: TurnBudgetOptions = {}) {
    this.#maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

    // A non-positive limit means no turn can ever run, which is a wiring mistake rather
    // than a budget — so it gets a stack trace, not a typed failure.
    if (this.#maxSteps < 1 || this.#maxTokens < 1) {
      throw new Error(
        `turn budget must be positive, got ${this.#maxSteps} steps and ${this.#maxTokens} tokens`,
      );
    }
  }

  /** One round trip through the model. */
  recordStep(): void {
    this.#steps += 1;
  }

  /**
   * Adds what one call cost.
   *
   * Takes the whole usage rather than a total so no call site gets to decide which half
   * counts — the provider already folds cached input into `inputTokens`, and a budget built
   * on the unsummed number would be wrong by most of the prompt.
   */
  recordUsage(usage: TokenUsage): void {
    this.#tokens += usage.inputTokens + usage.outputTokens;
  }

  spent(): { steps: number; tokens: number } {
    return { steps: this.#steps, tokens: this.#tokens };
  }

  /** Steps are reported before tokens, so a turn over both limits still fails once. */
  check(): BudgetVerdict {
    if (this.#steps > this.#maxSteps) {
      return exceeded(
        `step budget exceeded: ${this.#steps} model round trips, limit ${this.#maxSteps}`,
      );
    }
    if (this.#tokens > this.#maxTokens) {
      return exceeded(
        `token budget exceeded: ${this.#tokens} tokens spent, limit ${this.#maxTokens}`,
      );
    }
    return { ok: true };
  }
}

function exceeded(message: string): BudgetVerdict {
  return { ok: false, failure: { reason: "budget_exceeded", message } };
}
