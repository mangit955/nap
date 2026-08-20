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
 * @param script The responses one turn hands out, in call order. Its last entry should be a
 *   plain answer with no tool calls, because it is what a long turn will keep receiving.
 */
export function loopingLLMProvider(script: readonly LoopingResponse[]): LLMProvider {
  if (script.length === 0) {
    throw new RangeError("loopingLLMProvider needs at least one response to hand out");
  }

  return {
    startTurn: (): LLMTurn => {
      let consumed = 0;
      let usage: TokenUsage = NO_USAGE;

      return {
        complete: async (request: LLMRequest): Promise<LLMTurnResult> => {
          // Clamped rather than wrapped: wrapping would hand a finished turn another tool call
          // and run the loop until its step budget stopped it.
          const response = script[Math.min(consumed, script.length - 1)] as LoopingResponse;
          consumed += 1;

          for (const delta of response.thinking ?? []) request.onThinkingDelta?.(delta);
          for (const delta of response.streamedText ?? []) request.onTextDelta?.(delta);

          const spent = response.usage ?? NO_USAGE;
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
