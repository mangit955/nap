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
 *  - **Cached input counts as input, and says so.** The API reports `input_tokens` as the
 *    *uncached remainder*; the cache-read and cache-write counts sit in their own fields.
 *    Summing all three is what makes `inputTokens` the size of the prompt; keeping the two
 *    cached parts beside it is what lets the budget charge a cache read at a tenth of the
 *    price rather than at face value.
 *
 * The SDK is reached through a narrow injected `AnthropicClient` rather than by calling
 * the class directly, so every mapping and every failure path can be driven by a stub
 * with no network — the same arrangement the E2B adapter uses.
 */

import Anthropic, {
  APIConnectionError,
  APIError,
  type Middleware,
  RateLimitError,
} from "@anthropic-ai/sdk";
import type {
  BilledWeights,
  LLMContentBlock,
  LLMMessage,
  LLMObservationBlock,
  LLMProvider,
  LLMRequest,
  LLMToolCall,
  LLMTurn,
  LLMTurnOptions,
  LLMTurnResult,
  ModelCredentials,
  TokenUsage,
} from "@nap/shared/ports/llm-provider";
import { addUsage, billedWeightsFor, tokenUsage } from "@nap/shared/usage";
import { z } from "zod";
import { toDirectAnthropicModel } from "./anthropic.ts";
import { createOpenRouterClient, toOpenRouterModel } from "./openrouter.ts";

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
      options?: {
        signal?: AbortSignal | undefined;
        /** Per-request wrappers around the HTTP exchange; the idle watch reads the body here. */
        middleware?: ReadonlyArray<Middleware> | undefined;
      },
    ): {
      /**
       * The SDK's own event emitter. Both events hand over `(delta, snapshot)` — the piece
       * that just arrived, then the running total — which is why the listeners below read
       * the first argument and ignore the second.
       */
      on(event: "thinking" | "text", listener: (delta: string, snapshot: string) => void): void;
      /** Every raw event, of which only a `tool_use` block opening is read. */
      on(event: "streamEvent", listener: (event: Anthropic.MessageStreamEvent) => void): void;
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
  /** How long a stream may stay silent before it is abandoned. Defaults to `STREAM_IDLE_TIMEOUT_MS`. */
  idleTimeoutMs?: number;
  /**
   * A different model, effort or output ceiling than the defaults below.
   *
   * The reason this is configurable at all is cost. Most turns during development are spent
   * debugging the loop — did the tool calls come back well formed, did the events arrive in
   * order, did the commit land — and that needs a model that answers cheaply, not one that
   * answers best. Sonnet and Opus are structurally identical here: same SDK, same
   * `tool_use`/`tool_result` blocks, same streaming, same refusal semantics, so nothing
   * downstream can tell them apart. Swapping *vendors* to save money is a different and much
   * worse idea — see the note in `docs/GOTCHAS.md`.
   */
  model?: Anthropic.Model;
  effort?: Effort;
  maxTokens?: number;
  /**
   * How a client is built for a turn that brought its own key. Defaults to the real thing.
   *
   * Injected for the same reason `client` is, and it is not the same seam: `client` is the one
   * this process uses, while this is the one somebody *else's* credential produces. Without a
   * way to override it, the only way to observe which client a turn picked is to make a
   * request with it — a live call to a vendor from a unit test.
   */
  createClient?: (credentials: ModelCredentials) => AnthropicClient;
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
 * `openai/gpt-5.6-luna` at `xhigh` effort with adaptive thinking, summarized.
 *
 * **The default model is deliberately not Anthropic's**, even though everything below speaks
 * the Anthropic Messages API. The two are independent: OpenRouter publishes that API in front
 * of every vendor's models, so the request shape here is a *protocol* choice and the model is
 * a *cost* choice. Luna is roughly a twentieth of Opus per token, and a turn that proves the
 * loop works is not more convincing for having been expensive.
 *
 * Thinking is left on — disabling it makes a model occasionally write a tool call into its
 * prose, where nothing executes it and the turn silently does nothing. `summarized` asks for
 * readable reasoning; the default hides it. Whether any of it comes back is the *route's*
 * business, and on OpenRouter's Anthropic endpoint it does not — see the gotcha in
 * `docs/GOTCHAS.md`. Asking costs nothing and is what makes a route that does forward it work.
 *
 * No `temperature`, `top_p`, `top_k` or `budget_tokens`: the models reached this way reject
 * all four with a 400.
 *
 * A fully namespaced id, because a bare name is read as Anthropic's. That also makes this
 * default wrong for `--platform=anthropic`, which serves Anthropic's catalogue alone — a
 * caller reaching for the first-party API has to name a model it actually has.
 */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  model: "openai/gpt-5.6-luna",
  /*
   * `medium`, because it was measured rather than chosen — and because this used to say `xhigh`
   * while `NAP_EFFORT` said `medium`, so the API and anything falling back to this default were
   * running at different settings.
   *
   * Fifteen turns over five prompts at three levels: `medium` was the cheapest and the fastest,
   * and the app it produced on the hardest prompt was not worse — read back and compared rather
   * than taken on the model's word. `high` is the surprise, costing 2.3x `medium` on input where
   * `xhigh` costs 1.11x; what a level changes is how many times the loop goes round, not simply
   * how long it thinks.
   */
  effort: "medium",
  /** Room to think and answer across a long tool loop. */
  maxTokens: 64_000,
};

/** Total attempts, not retries — three tries, two waits. */
export const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

/**
 * How long a model stream may go without a single byte arriving before it is abandoned and tried
 * again.
 *
 * The SDK's own `timeout` cannot do this: it bounds the wait for a response's *headers* and is
 * cleared the moment they arrive, so a stream that goes quiet after opening was waited on for as
 * long as the socket stayed up — through every attempt.
 *
 * **Bytes, not the events a listener sees.** A model thinking without a summary, or writing a
 * large tool call's arguments (the API buffers each argument until it is whole), sends nothing a
 * listener can see for minutes at a time — only `ping` events, which the SDK's decoder drops
 * before any listener runs, or a proxy's keep-alive comments, which it never parses at all. Every
 * one of those is a byte on the response body, so counting bytes is what tells a model that is
 * busy from a connection that is gone. The cost of that choice: an upstream that hangs while a
 * proxy in front of it keeps the connection warm is not caught here, and nothing short of a
 * ceiling on total time could catch it without also cutting off a long, honest answer.
 *
 * Ninety seconds leaves room between heartbeats without waiting minutes for a silent attempt.
 * The cost of attempts that produce no stream activity is bounded by
 * `WORST_CASE_STALLED_CALL_MS` below.
 */
export const STREAM_IDLE_TIMEOUT_MS = 90_000;

/**
 * The longest one `complete` call can spend on a model that has stopped answering: every attempt
 * runs out its idle window, with the ordinary backoff between them. Steady streaming is not
 * bounded by time at all — a long answer is bounded by its output ceiling instead.
 */
export const WORST_CASE_STALLED_CALL_MS =
  MAX_ATTEMPTS * STREAM_IDLE_TIMEOUT_MS + BASE_BACKOFF_MS * (2 ** (MAX_ATTEMPTS - 1) - 1);

/**
 * A stream this provider abandoned because nothing arrived for the idle window.
 *
 * Its own type, because the SDK reports the abort that ends a stalled stream exactly as it reports
 * a person cancelling the turn — `APIUserAbortError` either way — and the two must never be
 * confused: one is the model being unavailable and worth another attempt, the other is somebody
 * asking for the work to stop.
 */
class StreamStalledError extends Error {
  constructor(idleMs: number) {
    super(`The model stopped responding: nothing arrived for ${idleMs / 1_000} seconds.`);
    this.name = "StreamStalledError";
  }
}

/**
 * How long to wait when the model itself is throttled, rather than the connection being unlucky.
 *
 * Half a second is the right scale for a dropped socket and two orders of magnitude too small
 * for a per-minute pool limit: all three attempts land inside the same throttled window and the
 * turn dies having waited a second and a half. Three seconds doubling to six spans most short
 * throttles, and costs nothing but latency — a rejected request bills no tokens.
 */
const RATE_LIMIT_BACKOFF_MS = 3_000;

/**
 * The error types that mean "the model, briefly" rather than "this request, always".
 *
 * These arrive with **no status** when the provider reports them *inside* the stream: an
 * upstream throttle on a 200 response is an SSE `error` frame, which the SDK turns into an
 * `APIError` carrying `body.error.type` and nothing else. See `docs/GOTCHAS.md` § Model and
 * provider — a status-based rule cannot see any of it.
 */
const TRANSIENT_ERROR_TYPES: readonly string[] = [
  "rate_limit_error",
  "overloaded_error",
  "api_error",
];

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
  if (cause instanceof StreamStalledError) return true;
  if (cause instanceof RateLimitError) return true;
  if (cause instanceof APIConnectionError) return true;
  if (cause instanceof APIError) {
    // The type before the status, because the throttle that prompted this rule has no status:
    // `RateLimitError` is only ever constructed from a 429 *response*, and a 200 that fails
    // mid-stream never produces one.
    if (typeof cause.type === "string" && TRANSIENT_ERROR_TYPES.includes(cause.type)) return true;
    return typeof cause.status === "number" && cause.status >= 500;
  }
  return false;
}

/** Whether the wait before the next attempt should be the throttled one. */
function isThrottled(cause: unknown): boolean {
  if (cause instanceof RateLimitError) return true;
  return (
    cause instanceof APIError &&
    (cause.type === "rate_limit_error" || cause.type === "overloaded_error")
  );
}

/**
 * The shape a vendor error body arrives in. Parsed rather than cast: it crosses a boundary from
 * somebody else's server, and the whole reason this exists is that its inside was being printed
 * to a user.
 */
const ErrorBodySchema = z.object({ error: z.object({ message: z.string().min(1) }) });

/**
 * What to tell the user happened.
 *
 * `APIError` builds its own message by stringifying the entire body when it cannot find a
 * `message` at the top level — and on this route the sentence is one level down, at
 * `body.error.message`. The result was a wall of JSON in the chat where a plain sentence was
 * available the whole time.
 */
export function describeError(cause: unknown): string {
  if (cause instanceof APIError) {
    const body = ErrorBodySchema.safeParse(cause.error);
    if (body.success) return body.data.error.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Total input, including the parts the API bills separately because they were cached, with
 * those parts kept apart. OpenRouter sends `null` for a model that caches nothing, and the
 * shared constructor reads that, or a field missing outright, as zero.
 */
export function toTokenUsage(usage: AnthropicMessage["usage"] | undefined): TokenUsage {
  if (usage === undefined) return NO_USAGE;
  return tokenUsage({
    uncached: usage.input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
    cacheRead: usage.cache_read_input_tokens,
    output: usage.output_tokens,
  });
}

/**
 * Where a cache breakpoint goes, and why there are at most four.
 *
 * Caching is a *prefix* match, and the API renders a request as `tools` → `system` →
 * `messages`. So a marker on the system block covers the tool schemas as well, and a marker on
 * a message covers everything before it. Four is the API's ceiling, and this uses it exactly:
 *
 *  - **The system block.** It is the application's instructions and nothing else — the context
 *    engine keeps everything that varies out of it — so it is the same bytes for every turn of
 *    every session, and only the first request after a quiet five minutes pays to write it.
 *  - **Up to two messages the context engine marks** with `cacheBreakpoint`: where the previous
 *    turn's history ended, which this request reads, and where this one's ends, which the next
 *    turn reads. Only the engine knows which history is settled, so it says; this places them.
 *  - **The last block of the last message.** Each step appends the tool calls it made and the
 *    results it got, then re-sends the lot. Without this, a file read early in a turn is
 *    re-billed at full price on every step that follows it.
 *
 * **Explicit markers rather than the top-level `cache_control` the SDK also accepts.** The
 * automatic one places the breakpoint for you and is simpler, but it exists only on the
 * first-party API, and the route this project uses is OpenRouter's translating proxy, where the
 * per-block markers are what was measured to be accepted.
 *
 * The 5-minute default is deliberate: a turn's steps are seconds apart, and a 5-minute write
 * costs 1.25× against a read's 0.1×, so it pays for itself on the second call. The one-hour TTL
 * doubles the write and needs a third call to break even — which is a bet on how fast somebody
 * types, and not one to make without numbers.
 *
 * **A prefix shorter than the model's minimum silently does not cache** — no error, just a zero
 * in `cache_creation_input_tokens`. See the gotcha in `docs/GOTCHAS.md` for the per-model figures and
 * what ours measures.
 */
const CACHE_BREAKPOINT = { type: "ephemeral" } as const;

/**
 * The block kinds this provider produces, and the reason the union is spelled out rather
 * than using the SDK's `ContentBlockParam`: that one also covers thinking blocks, which carry
 * no `cache_control`. Narrowing here is what lets a breakpoint be attached without a cast.
 */
type ApiBlock =
  | Anthropic.ImageBlockParam
  | Anthropic.TextBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam;

type ApiMessage = { role: LLMMessage["role"]; content: ApiBlock[] };

function toApiContent(content: LLMMessage["content"]): ApiBlock[] {
  // A bare string is valid to send but has nowhere to hang a marker, so it becomes a block.
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(toApiBlock);
}

function toApiObservation(
  block: LLMObservationBlock,
): Anthropic.TextBlockParam | Anthropic.ImageBlockParam {
  return block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "image", source: { type: "base64", media_type: block.mediaType, data: block.data } };
}

function toApiBlock(block: LLMContentBlock): ApiBlock {
  switch (block.type) {
    case "text":
    case "image":
      return toApiObservation(block);
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolCallId,
        content:
          typeof block.content === "string" ? block.content : block.content.map(toApiObservation),
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

/** A message in the API's shape, carrying the context engine's breakpoint on its last block. */
function toApiMessage(message: LLMMessage): ApiMessage {
  const content = toApiContent(message.content);
  const last = content.at(-1);
  if (message.cacheBreakpoint === true && last !== undefined) last.cache_control = CACHE_BREAKPOINT;
  return { role: message.role, content };
}

/** Builds the request body. Exported because it is cheap to test and easy to get wrong. */
export function toRequestParams(
  request: LLMRequest,
  config: ModelConfig = DEFAULT_MODEL_CONFIG,
): Anthropic.MessageStreamParams {
  return {
    model: config.model,
    max_tokens: Math.min(request.maxOutputTokens ?? config.maxTokens, config.maxTokens),
    ...(request.purpose !== undefined
      ? { thinking: { type: "disabled" as const } }
      : {
          output_config: { effort: config.effort },
          thinking: { type: "adaptive" as const, display: "summarized" as const },
        }),
    system: [{ type: "text", text: request.systemPrompt, cache_control: CACHE_BREAKPOINT }],
    messages: withConversationBreakpoint(request.messages.map(toApiMessage)),
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

  return {
    type: "message",
    text: texts.join(""),
    toolCalls,
    usage,
    ...(message.stop_reason === "max_tokens" ? { truncated: true } : {}),
  };
}

export class ClaudeProvider implements LLMProvider {
  readonly #client: AnthropicClient;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #idleTimeoutMs: number;
  readonly #config: ModelConfig;
  /**
   * One client per credential, kept for the life of the process.
   *
   * Not an optimisation for its own sake: a client owns an HTTP agent and its connection pool,
   * so building one per turn means a fresh TLS handshake on every message somebody sends, and
   * a busy user would leave a trail of pools nothing closes. Keyed by platform *and* key,
   * because the same string is a different credential at a different vendor.
   *
   * The map holds secrets, which is why it is private and why nothing ever enumerates it. It
   * is also unbounded — one entry per distinct key this process has ever seen. That is fine at
   * the scale this runs at and is the kind of thing to notice before it is not: the fix is an
   * LRU, not a rebuild.
   */
  readonly #clients = new Map<string, AnthropicClient>();
  readonly #createClient: (credentials: ModelCredentials) => AnthropicClient;

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
    this.#idleTimeoutMs = options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
    this.#createClient = options.createClient ?? createClientFor;
  }

  startTurn(options: LLMTurnOptions = {}): LLMTurn {
    // The model and the credential are the only two things a caller may vary, and both are
    // facts about *who asked* rather than preferences. Effort, thinking, retries and the cache
    // breakpoints stay this provider's, because they are policy tuned to the deployment — and
    // a caller that could set `maxTokens` on this route could reserve the whole balance, since
    // OpenRouter admits a request against the ceiling.
    const model =
      options.model === undefined
        ? this.#config.model
        : // Spelled for whichever vendor is about to be asked. The rest of the codebase names
          // models the OpenRouter way, so an Anthropic key needs the namespace taken back off;
          // without this, somebody's own key would 404 on every turn and the reason would be
          // three layers away.
          toModelId(options.model, options.credentials?.platform);

    // Looked up by the codebase's spelling of the model, which is the one the table is keyed by:
    // a bare id is Anthropic's, as everywhere else here.
    const weights = billedWeightsFor(toOpenRouterModel(options.model ?? this.#config.model));
    return new ClaudeTurn(
      this.#clientFor(options.credentials),
      { sleep: this.#sleep, idleTimeoutMs: this.#idleTimeoutMs },
      { ...this.#config, model },
      weights,
    );
  }

  /**
   * The client a turn's credential buys, or this process's own when it brought none.
   *
   * The default path is deliberately untouched — an injected stub stays the client in tests,
   * and a deployment with no per-user keys behaves exactly as it did before any of this.
   */
  #clientFor(credentials: ModelCredentials | undefined): AnthropicClient {
    if (credentials === undefined) return this.#client;

    const cacheKey = `${credentials.platform}:${credentials.apiKey}`;
    const cached = this.#clients.get(cacheKey);
    if (cached !== undefined) return cached;

    const built = this.#createClient(credentials);
    this.#clients.set(cacheKey, built);
    return built;
  }
}

/**
 * A real client for somebody else's key.
 *
 * Split out and injectable for the same reason `client` itself is: constructing one is the
 * only step here that reaches the network when used, so a test that wants to prove *which*
 * client a turn picked must be able to answer without making a request. Every version of this
 * test that called `complete` on a real client sent a live request to a vendor, which is
 * exactly what `test:integration` exists to contain.
 */
function createClientFor(credentials: ModelCredentials): AnthropicClient {
  return credentials.platform === "openrouter"
    ? createOpenRouterClient({ apiKey: credentials.apiKey })
    : // Retries off, for the reason the constructor gives: the loop in `complete` is the
      // policy, and a second invisible one underneath it would make "gave up after N attempts"
      // untestable and the real attempt count triple what it says.
      new Anthropic({ apiKey: credentials.apiKey, maxRetries: 0 });
}

/**
 * A model id spelled the way the vendor about to be asked spells it.
 *
 * Exported so the mapping can be pinned directly: it is one line with two branches and three
 * ways to be silently wrong, and every one of them surfaces as a 404 from somebody else's
 * server rather than as anything this codebase says.
 */
export function toModelId(
  model: string,
  platform: ModelCredentials["platform"] | undefined,
): string {
  return platform === "anthropic" ? toDirectAnthropicModel(model) : model;
}

/**
 * One attempt's idle window: the signal its stream is opened with, and the `touch` that every sign
 * of life calls to start the window again.
 *
 * Armed before the request is sent, so a connection that never answers at all is caught by the
 * same window as one that answers and then goes quiet. The turn's own signal is folded in, so a
 * cancel still ends the stream at once — and `stalled` is never true of an attempt the turn
 * cancelled, whichever of the two fired first.
 */
function watchIdle(idleMs: number, cancel: AbortSignal | undefined) {
  const own = new AbortController();
  let fired = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    // A late chunk after the attempt is over must not leave a timer armed behind it.
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      own.abort();
    }, idleMs);
  };
  touch();
  return {
    signal: cancel === undefined ? own.signal : AbortSignal.any([cancel, own.signal]),
    touch,
    stalled: () => fired && cancel?.aborted !== true,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/**
 * Calls `touch` for every chunk of the response body. Headers alone are not stream activity.
 *
 * Request middleware rather than a custom `fetch` on the client, because the window belongs to one
 * attempt and a client is shared by every turn in the process. The body is handed on unchanged:
 * the SDK still decodes it, and this only watches it go past.
 */
function touchOnEveryChunk(touch: () => void): Middleware {
  return async (request, next) => {
    const response = await next(request);
    if (response.body === null) return response;
    const watched = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          touch();
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(watched, response);
  };
}

class ClaudeTurn implements LLMTurn {
  readonly #client: AnthropicClient;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #idleTimeoutMs: number;
  readonly #config: ModelConfig;
  /** An own property rather than a getter, so a wrapper spreading this turn keeps it. */
  readonly billedWeights: BilledWeights;
  #usage: TokenUsage = NO_USAGE;

  constructor(
    client: AnthropicClient,
    timing: { sleep: (ms: number) => Promise<void>; idleTimeoutMs: number },
    config: ModelConfig,
    billedWeights: BilledWeights,
  ) {
    this.#client = client;
    this.#sleep = timing.sleep;
    this.#idleTimeoutMs = timing.idleTimeoutMs;
    this.#config = config;
    this.billedWeights = billedWeights;
  }

  async complete(request: LLMRequest): Promise<LLMTurnResult> {
    const body = toRequestParams(request, this.#config);
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      // Whether this attempt has handed the caller any of the answer's prose. Once it has, a
      // failure is not retried here: a retry is a new stream that writes the answer from its
      // first word, and the words already shown cannot be taken back, so the person would read
      // the opening twice. The caller knows what was shown and can ask for only the rest.
      let shown = false;
      const idle = watchIdle(this.#idleTimeoutMs, request.signal);
      try {
        const message = await this.#stream(body, request, idle, () => {
          shown = true;
        });
        return this.#record(toTurnResult(message));
      } catch (cause) {
        // The SDK reports the abort that ends a stalled stream exactly as it reports a cancel, so
        // the watch says which it was — and a cancelled turn is never retried, whatever fired.
        // A stalled error body still yields the HTTP status the SDK already received. Keep a
        // permanent rejection, such as a bad key, rather than turning it into a retryable stall.
        const permanent =
          cause instanceof APIError && typeof cause.status === "number" && !isRetryable(cause);
        lastError =
          idle.stalled() && !permanent ? new StreamStalledError(this.#idleTimeoutMs) : cause;
        if (request.signal?.aborted === true || !isRetryable(lastError) || shown) break;
        if (attempt < MAX_ATTEMPTS) {
          const base = isThrottled(lastError) ? RATE_LIMIT_BACKOFF_MS : BASE_BACKOFF_MS;
          await this.#sleep(base * 2 ** (attempt - 1));
        }
      }
    }

    return this.#record({
      type: "error",
      message: describeError(lastError),
      retryable: isRetryable(lastError),
      usage: NO_USAGE,
    });
  }

  usage(): TokenUsage {
    return this.#usage;
  }

  /**
   * One attempt: opens the stream under its idle window, forwards what the caller asked to hear,
   * and resolves to the assembled message. The window is disarmed however the attempt ends, so
   * none is left running through the backoff before the next one.
   */
  async #stream(
    body: Anthropic.MessageStreamParams,
    request: LLMRequest,
    idle: ReturnType<typeof watchIdle>,
    onShown: () => void,
  ): Promise<AnthropicMessage> {
    try {
      const stream = this.#client.messages.stream(body, {
        signal: idle.signal,
        middleware: [touchOnEveryChunk(idle.touch)],
      });
      // Every event is a sign of life too. The body watch already sees the bytes behind it on a
      // real client; this is what keeps a client without a body — a stub — honest about it.
      stream.on("streamEvent", (event) => {
        idle.touch();
        if (event.type === "content_block_start" && event.content_block.type === "tool_use")
          request.onToolCallStart?.();
      });
      // Subscribed per attempt rather than once, because each attempt is its own stream.
      // A retried attempt therefore re-sends the reasoning from the beginning — the model
      // is genuinely thinking again, and a repeated thought is a better answer than a turn
      // that falls silent the moment the first attempt is dropped.
      if (request.onThinkingDelta !== undefined) {
        const forward = request.onThinkingDelta;
        stream.on("thinking", (delta) => forward(delta));
      }
      if (request.onTextDelta !== undefined) {
        const forward = request.onTextDelta;
        stream.on("text", (delta) => {
          onShown();
          forward(delta);
        });
      }
      return await stream.finalMessage();
    } finally {
      idle.stop();
    }
  }

  #record(result: LLMTurnResult): LLMTurnResult {
    this.#usage = addUsage(this.#usage, result.usage);
    return result;
  }
}
