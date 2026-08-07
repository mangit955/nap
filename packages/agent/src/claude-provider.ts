/**
 * The real `LLMProvider`: Claude, reached through the Anthropic SDK.
 *
 * This is the only module in the repo that knows which model we run, how hard it is asked
 * to think, or what an SDK error looks like. That is the whole point of the port — see
 * `docs/PLAN.md` §0 — so those decisions stay in one file rather than spreading across
 * every caller.
 *
 * Four choices here are worth explaining, because none is obvious from the code:
 *
 *  - **Streaming, always.** Not because anything consumes the chunks — nothing does yet —
 *    but because a non-streaming request with a large `max_tokens` runs into the SDK's
 *    HTTP timeout. `finalMessage()` gives back the assembled message either way.
 *  - **We own the retry loop.** The SDK retries by default, which would be fine except
 *    that it is invisible: "gives up after N attempts" is a policy this project has to be
 *    able to test, so the client is constructed with retries off and the loop below is
 *    the only one that runs.
 *  - **A refusal never touches `content`.** Safety classifiers can decline before the
 *    model writes anything, so the array is empty and `content[0].text` would throw. The
 *    branch returns before it can.
 *  - **Cached input counts as input.** The API reports `input_tokens` as the *uncached
 *    remainder*; the cache-read and cache-write counts sit in their own fields. Summing
 *    all three is what makes the number mean "what this call actually cost us", which is
 *    what a budget needs.
 *
 * The SDK is reached through a narrow injected `AnthropicClient` rather than by calling
 * the class directly, so every mapping and every failure path can be driven by a stub
 * with no network — the same arrangement the E2B adapter uses.
 */

import Anthropic, { APIConnectionError, APIError, RateLimitError } from "@anthropic-ai/sdk";
import type {
  LLMContentBlock,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMToolCall,
  LLMTurn,
  LLMTurnResult,
  TokenUsage,
} from "@nap/shared/ports/llm-provider";

/** The assembled response. Named locally so tests do not reach into the SDK's namespace. */
export type AnthropicMessage = Anthropic.Message;

/** The slice of the SDK this provider uses. Narrow on purpose: it is what a stub must fake. */
export type AnthropicClient = {
  messages: {
    stream(
      body: Anthropic.MessageStreamParams,
      // `| undefined` explicitly: under exactOptionalPropertyTypes an absent signal and
      // one passed as undefined are different types, and a request without a signal is
      // the normal case.
      options?: { signal?: AbortSignal | undefined },
    ): { finalMessage(): Promise<AnthropicMessage> };
  };
};

export type ClaudeProviderOptions = {
  /** Defaults to the real SDK. Tests pass a stub. */
  client?: AnthropicClient;
  apiKey?: string;
  /** Injected so the retry tests do not spend their backoff in real time. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * `claude-opus-5` at `xhigh` effort with adaptive thinking, summarized.
 *
 * `xhigh` is the setting this model is tuned for on coding and agentic work. Thinking is
 * left on — disabling it makes the model occasionally write a tool call into its prose,
 * where nothing executes it and the turn silently does nothing. `summarized` keeps the
 * reasoning readable for the day the UI shows it; the default hides it.
 *
 * No `temperature`, `top_p`, `top_k` or `budget_tokens`: this model rejects all four with
 * a 400.
 */
const MODEL: Anthropic.Model = "claude-opus-5";
const EFFORT = "xhigh" as const;
/** Room to think and answer across a long tool loop. */
const MAX_TOKENS = 64_000;

/** Total attempts, not retries — three tries, two waits. */
export const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether trying the same request again could plausibly work.
 *
 * Rate limits, server faults and dropped connections are the model being briefly
 * unreachable. A 400 or a bad key is the request itself being wrong, and repeating it
 * just spends money on the same answer.
 */
export function isRetryable(cause: unknown): boolean {
  if (cause instanceof RateLimitError) return true;
  if (cause instanceof APIConnectionError) return true;
  if (cause instanceof APIError) return typeof cause.status === "number" && cause.status >= 500;
  return false;
}

/** Total input, including the parts the API bills separately because they were cached. */
export function toTokenUsage(usage: AnthropicMessage["usage"] | undefined): TokenUsage {
  if (usage === undefined) return NO_USAGE;
  return {
    inputTokens:
      usage.input_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens,
  };
}

function toApiContent(content: LLMMessage["content"]): Anthropic.MessageParam["content"] {
  if (typeof content === "string") return content;
  return content.map(toApiBlock);
}

function toApiBlock(block: LLMContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolCallId,
        content: block.content,
        is_error: block.isError,
      };
  }
}

/** Builds the request body. Exported because it is cheap to test and easy to get wrong. */
export function toRequestParams(request: LLMRequest): Anthropic.MessageStreamParams {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: EFFORT },
    thinking: { type: "adaptive", display: "summarized" },
    system: request.systemPrompt,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: toApiContent(message.content),
    })),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    })),
  };
}

/** Maps an assembled response onto our result union. */
export function toTurnResult(message: AnthropicMessage): LLMTurnResult {
  const usage = toTokenUsage(message.usage);

  // Before `content` — on a pre-output refusal there is nothing in it to read.
  if (message.stop_reason === "refusal") return { type: "refusal", usage };

  const texts: string[] = [];
  const toolCalls: LLMToolCall[] = [];

  for (const block of message.content) {
    if (block.type === "text") texts.push(block.text);
    // Thinking blocks are reasoning, not the answer, and never reach the conversation.
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }

  return { type: "message", text: texts.join(""), toolCalls, usage };
}

export class ClaudeProvider implements LLMProvider {
  readonly #client: AnthropicClient;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: ClaudeProviderOptions = {}) {
    this.#client =
      options.client ??
      // Retries off: the loop in `complete` is the policy, and a second invisible one
      // underneath it would make "gave up after N attempts" untestable and the real
      // attempt count triple what it says.
      new Anthropic({ apiKey: options.apiKey, maxRetries: 0 });
    this.#sleep = options.sleep ?? defaultSleep;
  }

  startTurn(): LLMTurn {
    return new ClaudeTurn(this.#client, this.#sleep);
  }
}

class ClaudeTurn implements LLMTurn {
  readonly #client: AnthropicClient;
  readonly #sleep: (ms: number) => Promise<void>;
  #usage: TokenUsage = NO_USAGE;

  constructor(client: AnthropicClient, sleep: (ms: number) => Promise<void>) {
    this.#client = client;
    this.#sleep = sleep;
  }

  async complete(request: LLMRequest): Promise<LLMTurnResult> {
    const body = toRequestParams(request);
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const message = await this.#client.messages
          .stream(body, { signal: request.signal })
          .finalMessage();
        return this.#record(toTurnResult(message));
      } catch (cause) {
        lastError = cause;
        if (!isRetryable(cause)) break;
        if (attempt < MAX_ATTEMPTS) await this.#sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }

    return this.#record({
      type: "error",
      message: lastError instanceof Error ? lastError.message : String(lastError),
      retryable: isRetryable(lastError),
      usage: NO_USAGE,
    });
  }

  usage(): TokenUsage {
    return this.#usage;
  }

  #record(result: LLMTurnResult): LLMTurnResult {
    this.#usage = {
      inputTokens: this.#usage.inputTokens + result.usage.inputTokens,
      outputTokens: this.#usage.outputTokens + result.usage.outputTokens,
    };
    return result;
  }
}
