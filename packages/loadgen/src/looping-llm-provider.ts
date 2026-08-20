/**
 * A model that answers the same short script, for as many turns as anyone asks.
 *
 * `ScriptedLLMProvider` is the fake every agent test uses and it deliberately throws past the
 * end of its script — a test that consumes a response nobody defined is asserting against
 * nothing. A load run is the one caller for which that is wrong: it does not know in advance
 * how many turns a twenty-minute ramp will start, and a provider that runs out mid-run fails
 * the harness rather than the system under test. Every failure a load report names has to be
 * the system's.
 *
 * So the script is per *turn* and unbounded in turns, and a turn that runs longer than its
 * script repeats the last response rather than throwing. The last entry is a plain answer, so
 * repeating it ends the agent's loop — which is exactly what a turn that has said everything it
 * has to say should do.
 *
 * It says nothing about how long a turn takes; that is `slow-ports.ts`, calibrated from a
 * funded run, and the two compose.
 */

import type {
  LLMProvider,
  LLMRequest,
  LLMToolCall,
  LLMTurn,
  LLMTurnResult,
  TokenUsage,
} from "@nap/shared/ports/llm-provider";

/** One response, with every field optional so a script writes only what it means. */
export type LoopingResponse = {
  text?: string;
  toolCalls?: LLMToolCall[];
  usage?: TokenUsage;
  /** Summarized reasoning, delivered before the response resolves, as a real stream does. */
  thinking?: string[];
  /** The answer's prose in pieces. A script setting this and `text` describes a real model. */
  streamedText?: string[];
};

const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * What a whole run spent, pretending.
 *
 * `docs/scaling-design.md` §23 asks the report to carry a token column even though the run spends
 * nothing, so that the shape of a real run's cost is visible beside its latencies. A turn's own
 * `usage()` cannot supply it — the handle is gone the moment the turn is — so the provider, which
 * outlives every turn it hands out, is the only thing that can keep the total.
 */
export type ProviderTotals = TokenUsage & { turns: number };

/** A provider that also knows what every turn through it has cost. */
export interface CountingLLMProvider extends LLMProvider {
  totals(): ProviderTotals;
}

/**
 * @param script The responses one turn hands out, in call order. Its last entry should be a
 *   plain answer with no tool calls, because it is what a long turn will keep receiving.
 */
export function loopingLLMProvider(script: readonly LoopingResponse[]): CountingLLMProvider {
  if (script.length === 0) {
    throw new RangeError("loopingLLMProvider needs at least one response to hand out");
  }

  // Counted from `startTurn` rather than from the first answer: a turn in flight is a turn the
  // run started, and leaving it out would make the count lag the load by exactly the turns that
  // are still running — which at a hundred concurrent is most of them.
  const totals: ProviderTotals = { turns: 0, inputTokens: 0, outputTokens: 0 };

  return {
    totals: () => ({ ...totals }),
    startTurn: (): LLMTurn => {
      totals.turns += 1;
      let consumed = 0;
      let usage: TokenUsage = NO_USAGE;

      return {
        complete: async (request: LLMRequest): Promise<LLMTurnResult> => {
          // Clamped rather than wrapped: wrapping would hand a finished turn another tool call
          // and run the loop until its step budget stopped it.
          const response = script[Math.min(consumed, script.length - 1)];
          consumed += 1;
          // The index is clamped into a non-empty array, so this cannot happen — but the repo
          // bans the assertion that would say so, and an explicit throw names the bug if the
          // clamp above is ever changed.
          if (response === undefined) throw new Error("the script index escaped its own clamp");

          for (const delta of response.thinking ?? []) request.onThinkingDelta?.(delta);
          for (const delta of response.streamedText ?? []) request.onTextDelta?.(delta);

          const spent = response.usage ?? NO_USAGE;
          totals.inputTokens += spent.inputTokens;
          totals.outputTokens += spent.outputTokens;
          usage = {
            inputTokens: usage.inputTokens + spent.inputTokens,
            outputTokens: usage.outputTokens + spent.outputTokens,
          };

          return {
            type: "message",
            text: response.text ?? "",
            toolCalls: response.toolCalls ?? [],
            usage: spent,
          };
        },
        usage: () => usage,
      };
    },
  };
}
