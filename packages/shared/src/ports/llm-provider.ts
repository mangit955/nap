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
 *
 * Usage is accounted per *turn*, and a turn is a handle rather than a mode. One model
 * turn is several round trips — the model asks for a tool, gets an answer, asks again —
 * and the interesting number is what the whole turn cost. Expressing that as
 * `startTurn()` rather than a `resetUsage()` call means the totals cannot drift: there is
 * no reset to forget, and two turns in flight at once cannot corrupt each other.
 */

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
};

/**
 * One piece of a message.
 *
 * Prose alone would make a tool call unanswerable: the model's request to run something
 * and the answer it gets back both have to travel in the conversation, addressed to each
 * other by id.
 */
export type LLMContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; content: string; isError: boolean };

export type LLMMessage = {
  role: "user" | "assistant";
  /** A bare string for plain prose; blocks when tool calls or their results are involved. */
  content: string | LLMContentBlock[];
};

export type LLMToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type LLMToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
};

export type LLMRequest = {
  systemPrompt: string;
  messages: LLMMessage[];
  /** Declared every call: a model that was not told about a tool never asks for one. */
  tools: LLMToolDefinition[];
  signal?: AbortSignal;
};

export type LLMTurnResult =
  | { type: "message"; text: string; toolCalls: LLMToolCall[]; usage: TokenUsage }
  | { type: "refusal"; usage: TokenUsage }
  | { type: "error"; message: string; retryable: boolean; usage: TokenUsage };

/**
 * What may vary between one turn and the next.
 *
 * The model is chosen per *turn* rather than per call because a turn is one conversation —
 * switching models between the tool call and its result would hand a second model a
 * transcript it never wrote. `startTurn` is already the boundary usage is accounted across,
 * which makes it the only seam this needs.
 *
 * A provider still owns *policy*: which models it will accept, retries, refusal handling,
 * thinking and caching. What it no longer owns is the assumption that there is exactly one.
 */
export type LLMTurnOptions = {
  /** Absent means the provider's configured default, which is the normal case. */
  model?: string | undefined;
};

export interface LLMProvider {
  /** Opens a fresh usage scope. One per turn. */
  startTurn(options?: LLMTurnOptions): LLMTurn;
}

export interface LLMTurn {
  complete(request: LLMRequest): Promise<LLMTurnResult>;
  /** Everything this turn has spent so far, across every call made through this handle. */
  usage(): TokenUsage;
}
