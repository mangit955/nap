/**
 * Model configuration and policy — **not** a cross-vendor abstraction.
 *
 * This interface exists so model id, reasoning effort, thinking display, retry and
 * refusal handling, and usage accounting live in one place. It is not an attempt to make
 * Claude swappable for another vendor; pretending otherwise would push vendor-specific
 * behaviour into callers that cannot handle it.
 *
 * A refusal is a first-class outcome. It gets its own branch of `LLMTurnResult` so a
 * caller cannot stumble into reading message content that is not there.
 */

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type LLMMessage = {
  role: "user" | "assistant";
  content: string;
};

export type LLMToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type LLMRequest = {
  systemPrompt: string;
  messages: LLMMessage[];
  signal?: AbortSignal;
};

export type LLMTurnResult =
  | { type: "message"; text: string; toolCalls: LLMToolCall[]; usage: TokenUsage }
  | { type: "refusal"; usage: TokenUsage }
  | { type: "error"; message: string; retryable: boolean; usage: TokenUsage };

export interface LLMProvider {
  complete(request: LLMRequest): Promise<LLMTurnResult>;
}
