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
 *  - **Streaming, always.** Originally because a non-streaming request with a large
 *    `max_tokens` runs into the SDK's HTTP timeout; now also because the chunks are read.
 *    `finalMessage()` still gives back the assembled message, so the two uses coexist:
 *    reasoning is forwarded as it arrives, the answer is taken from the assembled whole.
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
    ): {
      /**
       * The SDK's own event emitter. `thinking` hands over `(delta, snapshot)` — the piece
       * that just arrived, then the running total — which is why the listener below reads
       * the first argument and ignores the second.
       */
      on(event: "thinking", listener: (delta: string, snapshot: string) => void): void;
      finalMessage(): Promise<AnthropicMessage>;
    };
  };
};

export type ClaudeProviderOptions = {
  /** Defaults to the real SDK. Tests pass a stub. */
  client?: AnthropicClient;
  apiKey?: string;
  /** Injected so the retry tests do not spend their backoff in real time. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * A different model, effort or output ceiling than the defaults below.
   *
   * The reason this is configurable at all is cost. Most turns during development are spent
   * debugging the loop — did the tool calls come back well formed, did the events arrive in
   * order, did the commit land — and that needs a model that answers cheaply, not one that
   * answers best. Sonnet and Opus are structurally identical here: same SDK, same
   * `tool_use`/`tool_result` blocks, same streaming, same refusal semantics, so nothing
   * downstream can tell them apart. Swapping *vendors* to save money is a different and much
   * worse idea — see the note in `CLAUDE.md`.
   */
  model?: Anthropic.Model;
  effort?: Effort;
  maxTokens?: number;
};

/**
 * How hard the model is asked to think.
 *
 * Read off the SDK rather than written out, so a level the API adds or removes cannot be
 * accepted here and rejected there.
 */
export type Effort = NonNullable<
  NonNullable<Anthropic.MessageStreamParams["output_config"]>["effort"]
>;

/** Model, effort and output ceiling for one request. */
export type ModelConfig = {
  model: Anthropic.Model;
  effort: Effort;
  maxTokens: number;
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
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  model: "claude-opus-5",
  effort: "xhigh",
  /** Room to think and answer across a long tool loop. */
  maxTokens: 64_000,
};

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

/**
 * Where a cache breakpoint goes, and why there are exactly two.
 *
 * Caching is a *prefix* match, and the API renders a request as `tools` → `system` →
 * `messages`. So a marker on the system block covers the tool schemas as well, and a marker on
 * the final message covers everything before it. Two markers, against a ceiling of four:
 *
 *  - **The system block.** The runtime builds one prompt per turn and the agent loop sends it
 *    unchanged on every step, so a twelve-step turn pays for it once and reads it eleven times.
 *  - **The last block of the last message.** Each step appends the tool calls it made and the
 *    results it got, then re-sends the lot. Without this, a file read early in a turn is
 *    re-billed at full price on every step that follows it.
 *
 * **Explicit markers rather than the top-level `cache_control` the SDK also accepts.** The
 * automatic one places the breakpoint for you and is simpler, but it exists only on the
 * first-party API — Bedrock ignores it, and reaching the models through an AWS account is a
 * transport this repo deliberately supports. Per-block markers work on every platform.
 *
 * The 5-minute default is deliberate: a turn's steps are seconds apart, and a 5-minute write
 * costs 1.25× against a read's 0.1×, so it pays for itself on the second call. The one-hour TTL
 * doubles the write and needs a third call to break even — which is a bet on how fast somebody
 * types, and not one to make without numbers.
 *
 * **A prefix shorter than the model's minimum silently does not cache** — no error, just a zero
 * in `cache_creation_input_tokens`. See the gotcha in `CLAUDE.md` for the per-model figures and
 * what ours measures.
 */
const CACHE_BREAKPOINT = { type: "ephemeral" } as const;

/**
 * The three block kinds this provider produces, and the reason the union is spelled out rather
 * than using the SDK's `ContentBlockParam`: that one also covers thinking blocks, which carry
 * no `cache_control`. Narrowing here is what lets a breakpoint be attached without a cast.
 */
type ApiBlock =
  | Anthropic.TextBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam;

type ApiMessage = { role: LLMMessage["role"]; content: ApiBlock[] };

function toApiContent(content: LLMMessage["content"]): ApiBlock[] {
  // A bare string is valid to send but has nowhere to hang a marker, so it becomes a block.
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(toApiBlock);
}

function toApiBlock(block: LLMContentBlock): ApiBlock {
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

/**
 * Marks the very last content block, so the next step in the loop reads this step's
 * conversation from cache.
 *
 * The marker has to move with the conversation. Left on an earlier turn it would pin the cache
 * to a prefix that stops growing, and every step after that would re-read the same stale point
 * and pay full price for everything since.
 */
function withConversationBreakpoint(messages: ApiMessage[]): ApiMessage[] {
  const last = messages.at(-1);
  const lastBlock = last?.content.at(-1);
  // Nothing to mark: no messages, or a final message with empty content. Not a shape the agent
  // loop produces, but reaching past the end of an array is not how it should find that out.
  if (lastBlock === undefined) return messages;

  lastBlock.cache_control = CACHE_BREAKPOINT;
  return messages;
}

/** Builds the request body. Exported because it is cheap to test and easy to get wrong. */
export function toRequestParams(
  request: LLMRequest,
  config: ModelConfig = DEFAULT_MODEL_CONFIG,
): Anthropic.MessageStreamParams {
  return {
    model: config.model,
    max_tokens: config.maxTokens,
    output_config: { effort: config.effort },
    thinking: { type: "adaptive", display: "summarized" },
    system: [{ type: "text", text: request.systemPrompt, cache_control: CACHE_BREAKPOINT }],
    messages: withConversationBreakpoint(
      request.messages.map((message) => ({
        role: message.role,
        content: toApiContent(message.content),
      })),
    ),
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
  readonly #config: ModelConfig;

  constructor(options: ClaudeProviderOptions = {}) {
    this.#config = {
      model: options.model ?? DEFAULT_MODEL_CONFIG.model,
      effort: options.effort ?? DEFAULT_MODEL_CONFIG.effort,
      maxTokens: options.maxTokens ?? DEFAULT_MODEL_CONFIG.maxTokens,
    };
    this.#client =
      options.client ??
      // Retries off: the loop in `complete` is the policy, and a second invisible one
      // underneath it would make "gave up after N attempts" untestable and the real
      // attempt count triple what it says.
      new Anthropic({ apiKey: options.apiKey, maxRetries: 0 });
    this.#sleep = options.sleep ?? defaultSleep;
  }

  startTurn(): LLMTurn {
    return new ClaudeTurn(this.#client, this.#sleep, this.#config);
  }
}

class ClaudeTurn implements LLMTurn {
  readonly #client: AnthropicClient;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #config: ModelConfig;
  #usage: TokenUsage = NO_USAGE;

  constructor(client: AnthropicClient, sleep: (ms: number) => Promise<void>, config: ModelConfig) {
    this.#client = client;
    this.#sleep = sleep;
    this.#config = config;
  }

  async complete(request: LLMRequest): Promise<LLMTurnResult> {
    const body = toRequestParams(request, this.#config);
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const stream = this.#client.messages.stream(body, { signal: request.signal });
        // Subscribed per attempt rather than once, because each attempt is its own stream.
        // A retried attempt therefore re-sends the reasoning from the beginning — the model
        // is genuinely thinking again, and a repeated thought is a better answer than a turn
        // that falls silent the moment the first attempt is dropped.
        if (request.onThinkingDelta !== undefined) {
          const forward = request.onThinkingDelta;
          stream.on("thinking", (delta) => forward(delta));
        }
        const message = await stream.finalMessage();
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
