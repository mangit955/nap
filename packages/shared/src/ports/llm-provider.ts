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
  /**
   * Summarized reasoning, delivered as the model produces it rather than when the call ends.
   *
   * A turn is bursts of tool calls separated by silences of ten and twenty seconds, and the
   * silence *is* the model thinking — so this is the only thing that can say what is happening
   * while it happens. Absent means nobody is watching, and a provider that is handed nothing
   * costs nothing extra.
   *
   * `| undefined` spelled out, for the reason `signal` above does: under
   * `exactOptionalPropertyTypes` an absent callback and one passed as undefined are different
   * types, and not watching is the ordinary case.
   */
  onThinkingDelta?: ((delta: string) => void) | undefined;
  /**
   * The answer's own prose, as the model writes it.
   *
   * Separate from the reasoning because the two are different things to a reader, and
   * separate from the assembled `text` below because that only exists once the call is over.
   * A caller taking this must not also print the assembled text: the same words would
   * arrive twice.
   */
  onTextDelta?: ((delta: string) => void) | undefined;
};

export type LLMTurnResult =
  | { type: "message"; text: string; toolCalls: LLMToolCall[]; usage: TokenUsage }
  | { type: "refusal"; usage: TokenUsage }
  | { type: "error"; message: string; retryable: boolean; usage: TokenUsage };

/**
 * Whose account pays for a turn.
 *
 * A deployment cannot fund every stranger who opens it, so a person may bring their own key
 * and have their turns billed to them instead. That makes the *credential* the second thing
 * that varies between one turn and the next, for exactly the reason the model is the first:
 * it is a property of who asked, not of how this process is configured.
 *
 * The platform travels with the key because the two are inseparable — the same string is a
 * valid credential at one vendor and a 401 at the other, and it is what decides both which
 * client is built and how the model id is spelled.
 */
export type ModelCredentials = {
  platform: "openrouter" | "anthropic";
  apiKey: string;
};

/**
 * What may vary between one turn and the next.
 *
 * The model is chosen per *turn* rather than per call because a turn is one conversation —
 * switching models between the tool call and its result would hand a second model a
 * transcript it never wrote. `startTurn` is already the boundary usage is accounted across,
 * which makes it the only seam this needs, and the credential varies at the same boundary for
 * the same reason: a turn is billed to one account from beginning to end.
 *
 * A provider still owns *policy*: which models it will accept, retries, refusal handling,
 * thinking and caching. What it no longer owns is the assumption that there is exactly one
 * model, or exactly one payer.
 */
export type LLMTurnOptions = {
  /** Absent means the provider's configured default, which is the normal case. */
  model?: string | undefined;
  /**
   * Absent means this deployment's own account — which is what a turn on the free models runs
   * on, and what every turn ran on before anyone could bring a key.
   */
  credentials?: ModelCredentials | undefined;
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
