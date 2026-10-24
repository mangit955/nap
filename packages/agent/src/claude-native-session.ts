/** Runs inside an isolated authenticated runtime. This class makes no workspace isolation claim. */
import type {
  createSdkMcpServer,
  McpServerToolPolicy,
  Options,
  SDKUserMessage,
  TerminalReason,
} from "@anthropic-ai/claude-agent-sdk";
import { TOOL_NAMES, ToolNameSchema } from "@nap/shared/events";
import { type MediaAttachment, mediaBlocks } from "@nap/shared/media";
import type { TokenUsage } from "@nap/shared/ports/llm-provider";
import type { Result } from "@nap/shared/result";
import { z } from "zod";
import { DEFAULT_MAX_STEPS } from "./safety/budget.ts";
import { TOOL_SCHEMAS } from "./tools/definitions.ts";

type NativeError = {
  code:
    | "subscription_authentication_required"
    | "unavailable"
    | "protocol_error"
    | "cancelled"
    | "busy"
    | "limit_exceeded";
  message: string;
};
type NativeQuery = AsyncIterable<unknown> & {
  initializationResult(): Promise<unknown>;
  interrupt(): Promise<unknown>;
  close(): void;
};
export type ClaudeQueryFactory = (input: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => NativeQuery;
export const ClaudeNativeConfigSchema = z.strictObject({
  sessionId: z.uuid(),
  model: z.string().min(1).max(200),
  trustedInstructions: z.string().min(1).max(131_072),
  cwd: z.string().startsWith("/").max(4096),
  home: z.string().startsWith("/").max(4096),
  configDir: z.string().startsWith("/").max(4096),
  executablePath: z.string().startsWith("/").max(4096),
  environment: z.record(z.string(), z.string()),
});
const Account = z.object({
  account: z.object({
    apiProvider: z.literal("firstParty"),
    apiKeySource: z.literal("none"),
    tokenSource: z
      .string()
      .min(1)
      .refine((value) => value !== "none"),
  }),
});
const Frame = z.object({ type: z.string(), session_id: z.string().optional() });
const Init = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
  apiKeySource: z.literal("none"),
  tools: z.array(z.string()),
  mcp_servers: z.array(z.object({ name: z.string(), source: z.string(), status: z.string() })),
});
const Usage = z.object({
  input_tokens: z.int().nonnegative(),
  output_tokens: z.int().nonnegative(),
  cache_creation_input_tokens: z.int().nonnegative().optional(),
  cache_read_input_tokens: z.int().nonnegative().optional(),
});
const Completion = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  session_id: z.string(),
  is_error: z.boolean(),
  api_error_status: z.number().optional(),
  terminal_reason: z.string().nullable().optional(),
  usage: Usage.optional(),
});
const limitedReasons = new Set<string>([
  "blocking_limit",
  "rapid_refill_breaker",
  "prompt_too_long",
  "budget_exhausted",
  "max_turns",
] satisfies TerminalReason[]);
const failure = (code: NativeError["code"], message: string): Result<never, NativeError> => ({
  ok: false,
  error: { code, message },
});

function messageContent(
  prompt: string,
  attachments: readonly MediaAttachment[] | undefined,
): SDKUserMessage["message"]["content"] {
  if (attachments === undefined || attachments.length === 0) return prompt;
  const content: Exclude<SDKUserMessage["message"]["content"], string> = [
    { type: "text", text: prompt },
  ];
  for (const block of mediaBlocks(attachments)) {
    if (block.type === "text") content.push(block);
    else
      content.push({
        type: "image",
        source: { type: "base64", media_type: block.mediaType, data: block.data },
      });
  }
  return content;
}

class Prompts implements AsyncIterable<SDKUserMessage> {
  #pending: SDKUserMessage[] = [];
  #wake: (() => void) | undefined;
  #closed = false;
  offer(message: SDKUserMessage): void {
    this.#pending.push(message);
    this.#wake?.();
  }
  close(): void {
    this.#closed = true;
    this.#wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (!this.#closed) {
      const next = this.#pending.shift();
      if (next !== undefined) yield next;
      else
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
    }
  }
}

/** A native prompt stream, never Nap's Messages API/tool loop or assembled API history. */
export class ClaudeNativeSession {
  #closed = false;
  #active = false;
  #initialized = false;
  readonly #lifetime = new AbortController();
  readonly #iterator: AsyncIterator<unknown>;
  private constructor(
    private readonly id: string,
    private readonly prompts: Prompts,
    private readonly query: NativeQuery,
  ) {
    this.#iterator = query[Symbol.asyncIterator]();
  }

  static async open(
    config: z.infer<typeof ClaudeNativeConfigSchema>,
    dependencies: {
      query: ClaudeQueryFactory;
      tools: NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]>;
      initializationTimeoutMs?: number;
    },
  ): Promise<Result<ClaudeNativeSession, NativeError>> {
    const parsed = ClaudeNativeConfigSchema.safeParse(config);
    const initializationTimeoutMs = dependencies.initializationTimeoutMs ?? 10_000;
    if (
      !parsed.success ||
      !Number.isFinite(initializationTimeoutMs) ||
      initializationTimeoutMs < 1 ||
      initializationTimeoutMs > 20_000
    )
      return failure("unavailable", "The native runtime configuration is unavailable.");
    const { createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");
    const prompts = new Prompts();
    const environment: Record<string, string> = {
      HOME: config.home,
      CLAUDE_CONFIG_DIR: config.configDir,
    };
    for (const name of ["PATH", "LANG", "LC_ALL", "TMPDIR"])
      if (config.environment[name] !== undefined) environment[name] = config.environment[name];
    // SDK 0.3.310 forwards this wire option but omits it from its public server type.
    // native-helper:proof checks that initialize carries it rather than silently ignoring it.
    const server = {
      ...createSdkMcpServer({ name: "nap", version: "1.0.0", tools: dependencies.tools }),
      disableAutoBackground: true,
    };
    let session: ClaudeNativeSession | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const query = dependencies.query({
        prompt: prompts,
        options: {
          model: config.model,
          sessionId: config.sessionId,
          cwd: config.cwd,
          pathToClaudeCodeExecutable: config.executablePath,
          env: environment,
          systemPrompt: config.trustedInstructions,
          tools: [],
          settingSources: [],
          plugins: [],
          settings: { disableAllHooks: true },
          strictMcpConfig: true,
          permissionMode: "default",
          mcpServers: {
            nap: {
              ...server,
              tools: TOOL_NAMES.map(
                (name) => ({ name, permission_policy: "always_ask" }) satisfies McpServerToolPolicy,
              ),
            },
          },
          includePartialMessages: true,
          persistSession: true,
          maxTurns: DEFAULT_MAX_STEPS,
          canUseTool: async (name, input, options) => {
            const tool = name.startsWith("mcp__nap__")
              ? ToolNameSchema.safeParse(name.slice("mcp__nap__".length))
              : undefined;
            if (
              !options.signal.aborted &&
              session !== undefined &&
              session.#active &&
              !session.#closed &&
              options.matchedAskRule === undefined &&
              options.defaultToNo !== true &&
              options.mcpServer?.source === "sdk" &&
              options.mcpServer.name === "nap" &&
              tool?.success &&
              TOOL_SCHEMAS[tool.data].safeParse(input).success
            )
              return { behavior: "allow", updatedInput: input };
            return { behavior: "deny", message: "Only this project's Nap tools are available." };
          },
        },
      });
      session = new ClaudeNativeSession(config.sessionId, prompts, query);
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          session?.close();
          reject(new Error("Native initialization deadline exceeded"));
        }, initializationTimeoutMs);
      });
      if (!Account.safeParse(await Promise.race([query.initializationResult(), expired])).success) {
        session.close();
        return failure(
          "subscription_authentication_required",
          "Sign in with the selected Claude subscription. API and cloud credentials cannot run this target.",
        );
      }
      return { ok: true, value: session };
    } catch {
      session?.close();
      prompts.close();
      return failure("unavailable", "The native Claude runtime could not be initialized.");
    } finally {
      clearTimeout(timer);
    }
  }

  async run(
    input: {
      prompt: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      attachments?: readonly MediaAttachment[];
    },
    onMessage: (message: unknown) => Promise<void>,
  ): Promise<Result<{ usage: TokenUsage | null; usageIncomplete: true }, NativeError>> {
    if (this.#closed) return failure("unavailable", "The native session is closed.");
    if (this.#active)
      return failure("busy", "The native session already has an operation in progress.");
    if (input.signal?.aborted) return failure("cancelled", "The native turn was cancelled.");
    const signal =
      input.signal === undefined
        ? this.#lifetime.signal
        : AbortSignal.any([input.signal, this.#lifetime.signal]);
    const timeoutMs = input.timeoutMs ?? 600_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
      return failure("limit_exceeded", "The native turn deadline is unavailable.");
    this.#active = true;
    let abort = () => {};
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => {
        try {
          void this.query.interrupt().catch(() => {});
        } catch {}
        this.close();
        reject(new Error("Native turn cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        timedOut = true;
        this.close();
      }, timeoutMs);
    });
    try {
      this.prompts.offer({
        type: "user",
        session_id: this.id,
        parent_tool_use_id: null,
        client_composed: true,
        message: { role: "user", content: messageContent(input.prompt, input.attachments) },
      });
      for (;;) {
        const next = await Promise.race([this.#iterator.next(), stopped]);
        if (next.done) {
          this.close();
          return failure("protocol_error", "Native Claude ended without a completion receipt.");
        }
        const frame = Frame.safeParse(next.value);
        if (
          !frame.success ||
          (frame.data.session_id !== undefined && frame.data.session_id !== this.id)
        ) {
          this.close();
          return failure("protocol_error", "Native Claude returned a mismatched session receipt.");
        }
        if (
          frame.data.type === "system" &&
          typeof next.value === "object" &&
          next.value !== null &&
          "subtype" in next.value &&
          next.value.subtype === "init"
        ) {
          const init = Init.safeParse(next.value);
          if (
            !init.success ||
            init.data.tools.some(
              (name) =>
                name !== "EndConversation" &&
                !(
                  name.startsWith("mcp__nap__") &&
                  ToolNameSchema.safeParse(name.slice("mcp__nap__".length)).success
                ),
            ) ||
            !init.data.mcp_servers.some((server) => server.name === "nap") ||
            init.data.mcp_servers.some(
              (server) =>
                server.name !== "nap" || server.source !== "sdk" || server.status !== "connected",
            )
          ) {
            this.close();
            return failure(
              "protocol_error",
              "Native Claude did not confirm remote-only tool routing.",
            );
          }
          this.#initialized = true;
        }
        if (
          !this.#initialized &&
          ["assistant", "stream_event", "user", "result"].includes(frame.data.type)
        ) {
          this.close();
          return failure("protocol_error", "Native Claude did not initialize the scoped session.");
        }
        await Promise.race([onMessage(next.value), stopped]);
        if (frame.data.type !== "result") continue;
        const result = Completion.safeParse(next.value);
        if (!result.success) {
          this.close();
          return failure("protocol_error", "Native Claude returned an invalid completion receipt.");
        }
        if (
          result.data.terminal_reason === "aborted_tools" ||
          result.data.terminal_reason === "aborted_streaming"
        )
          return failure("cancelled", "The native turn was interrupted.");
        if (result.data.api_error_status === 401)
          return failure(
            "subscription_authentication_required",
            "Reconnect the selected Claude subscription before continuing.",
          );
        if (result.data.terminal_reason != null && result.data.terminal_reason !== "completed")
          return failure(
            limitedReasons.has(result.data.terminal_reason) ? "limit_exceeded" : "unavailable",
            "Native Claude stopped before completing this turn.",
          );
        if (
          result.data.subtype !== "success" ||
          result.data.is_error ||
          result.data.api_error_status !== undefined
        )
          return failure(
            result.data.api_error_status === 429 ||
              result.data.subtype === "error_max_turns" ||
              result.data.subtype === "error_max_budget_usd"
              ? "limit_exceeded"
              : "unavailable",
            "Native Claude could not complete this turn.",
          );
        const usage = result.data.usage;
        return {
          ok: true,
          value: {
            usage:
              usage === undefined
                ? null
                : {
                    inputTokens:
                      usage.input_tokens +
                      (usage.cache_creation_input_tokens ?? 0) +
                      (usage.cache_read_input_tokens ?? 0),
                    outputTokens: usage.output_tokens,
                  },
            usageIncomplete: true,
          },
        };
      }
    } catch {
      const cancelled = signal.aborted;
      this.close();
      return failure(
        timedOut ? "limit_exceeded" : cancelled ? "cancelled" : "unavailable",
        timedOut
          ? "The native turn exceeded its time limit."
          : cancelled
            ? "The native turn was cancelled."
            : "The native turn lost its execution receipt. It was not retried.",
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.#active = false;
    }
  }

  /** Closing the SDK is not a physical termination proof; the supervisor must still confirm it. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.prompts.close();
    this.#lifetime.abort();
    try {
      this.query.close();
    } catch {}
  }
}
