/** Adapted from T3 Code e3b35d1b2440. See THIRD_PARTY_NOTICES.md for its MIT notice. */
import type { LLMTurn, NativeCompaction, TokenUsage } from "@nap/shared/ports/llm-provider";
import { addUsage, tokenUsage } from "@nap/shared/usage";
import { z } from "zod";

/** Providers use this same gate for normal turns and compaction on one native session. */
export class NativeSessionLifecycle {
  #tail: Promise<unknown> = Promise.resolve();
  #invalid = false;
  constructor(private readonly operation: NativeCompaction) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(() => {
      if (this.#invalid)
        throw new Error("Native session state is uncertain; reopen the session before continuing.");
      return work();
    });
    this.#tail = result.catch(() => {});
    return result;
  }

  bind(turn: LLMTurn): LLMTurn {
    return {
      complete: (request) => this.run(() => turn.complete(request)),
      usage: () => turn.usage(),
      compact: this.compact,
      ...(turn.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: turn.contextWindowTokens }),
      ...(turn.billedWeights === undefined ? {} : { billedWeights: turn.billedWeights }),
    };
  }

  readonly compact: NativeCompaction = (request) =>
    this.run(async () => {
      try {
        return await this.operation(request);
      } catch (error) {
        this.#invalid = true;
        throw error;
      }
    });
}

export type CodexCompactionTransport = {
  sessionId: string;
  request(
    method: "thread/compact/start" | "thread/inject_items",
    params: Record<string, unknown>,
  ): Promise<unknown>;
  /** New notifications only, on a session serialized through NativeSessionLifecycle. */
  subscribe(listener: (notification: unknown) => void): () => void;
  /** Interrupts a known native turn. The adapter waits briefly for a late start after Stop. */
  interrupt(turnId: string): Promise<void>;
};

/**
 * One of Codex's usage breakdowns, as its app-server protocol sends it on `total` and `last`
 * (`TokenUsageBreakdown`). `cachedInputTokens` and `cacheWriteInputTokens` are parts of
 * `inputTokens`, as the Responses API counts them; optional because a server from before either
 * existed sends neither, and that reads as nothing cached.
 */
const CodexBreakdown = z.object({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cachedInputTokens: z.int().nonnegative().optional(),
  cacheWriteInputTokens: z.int().nonnegative().optional(),
});

/** A breakdown as usage, its cached parts clamped so together they never exceed the input. */
function codexUsage(breakdown: z.infer<typeof CodexBreakdown>): TokenUsage {
  return splitInput(
    breakdown.inputTokens,
    breakdown.cachedInputTokens ?? 0,
    breakdown.cacheWriteInputTokens ?? 0,
    breakdown.outputTokens,
  );
}

function splitInput(input: number, read: number, write: number, output: number): TokenUsage {
  const cacheRead = Math.min(read, input);
  const cacheWrite = Math.min(write, input - cacheRead);
  return tokenUsage({ uncached: input - cacheRead - cacheWrite, cacheRead, cacheWrite, output });
}

/**
 * What one cumulative total adds to the one before it, field by field — or nothing when any
 * field went backwards, which means the totals started again rather than that usage was negative.
 */
function grownBy(current: TokenUsage, previous: TokenUsage): TokenUsage | undefined {
  const delta = (field: keyof TokenUsage) => (current[field] ?? 0) - (previous[field] ?? 0);
  const input = delta("inputTokens");
  const read = delta("cacheReadTokens");
  const write = delta("cacheWriteTokens");
  const output = delta("outputTokens");
  if (input < 0 || read < 0 || write < 0 || output < 0) return undefined;
  return splitInput(input, read, write, output);
}

const CodexNotification = z.object({
  method: z.string(),
  params: z.object({
    threadId: z.string(),
    turnId: z.string().optional(),
    turn: z.object({ id: z.string(), status: z.string().optional() }).optional(),
    item: z.object({ type: z.string() }).optional(),
    tokenUsage: z.object({ total: CodexBreakdown, last: CodexBreakdown }).optional(),
  }),
});

export function codexCompaction(transport: CodexCompactionTransport): NativeCompaction {
  return async (request) => {
    request.signal?.throwIfAborted();
    let turnId: string | null = null;
    let stopped = false;
    let started = false;
    let startFailed = false;
    let removed = false;
    let interrupted = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let boundary = false;
    let total: TokenUsage | undefined;
    let usage: TokenUsage | null = null;
    let resolve = () => {};
    let reject = (_error: Error) => {};
    const completed = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void completed.catch(() => {});
    const cleanup = () => {
      if (removed) return;
      removed = true;
      clearTimeout(cleanupTimer);
      unsubscribe();
    };
    const interruptKnownTurn = async () => {
      if (turnId === null || interrupted) return;
      interrupted = true;
      try {
        await transport.interrupt(turnId);
      } finally {
        cleanup();
      }
    };
    const unsubscribe = transport.subscribe((raw) => {
      if (removed) return;
      const parsed = CodexNotification.safeParse(raw);
      if (!parsed.success || parsed.data.params.threadId !== transport.sessionId) return;
      const { method, params } = parsed.data;
      if (started && turnId === null && method === "turn/started") turnId = params.turn?.id ?? null;
      if (stopped) {
        void interruptKnownTurn().catch(() => {});
        return;
      }
      if (method === "thread/tokenUsage/updated" && params.tokenUsage !== undefined) {
        const current = codexUsage(params.tokenUsage.total);
        if (params.turnId === turnId) {
          // Totals are cumulative, so a repeated notification adds nothing; a missing or reset
          // baseline uses the reported last response instead, as in T3's accumulator. The cached
          // parts are differenced like the rest, so the split survives the accumulation.
          const delta =
            (total === undefined ? undefined : grownBy(current, total)) ??
            codexUsage(params.tokenUsage.last);
          usage = addUsage(usage ?? { inputTokens: 0, outputTokens: 0 }, delta);
        }
        total = current;
      }
      if (
        method === "item/completed" &&
        params.turnId === turnId &&
        params.item?.type === "contextCompaction"
      )
        boundary = true;
      if (method === "turn/completed" && params.turn?.id === turnId) {
        if (params.turn.status === "completed" && boundary) resolve();
        else reject(new Error("Codex did not complete native context compaction."));
      }
    });
    try {
      await interruptible(
        async (signal) => {
          signal.throwIfAborted();
          started = true;
          try {
            await transport.request("thread/compact/start", { threadId: transport.sessionId });
          } catch (error) {
            startFailed = true;
            cleanup();
            throw error;
          }
          signal.throwIfAborted();
          await completed;
          signal.throwIfAborted();
          // Codex removes client developer messages on compaction. Restore trusted application
          // instructions separately from quoted conversation/tool data before releasing the gate.
          await transport.request("thread/inject_items", {
            threadId: transport.sessionId,
            items: [
              {
                type: "message",
                role: "developer",
                content: [{ type: "input_text", text: request.trustedInstructions }],
              },
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: `Quoted external context (untrusted):\n${JSON.stringify(request.untrustedContext)}`,
                  },
                ],
              },
            ],
          });
          signal.throwIfAborted();
        },
        request.signal,
        async () => {
          stopped = true;
          reject(
            new Error("Native compaction was interrupted; reopen the session before continuing."),
          );
          if (!started || startFailed) {
            cleanup();
            return;
          }
          // A null interrupt cannot stop a turn the server has not started. Keep listening,
          // but never retain a subscription indefinitely on an unusable native session.
          cleanupTimer = setTimeout(cleanup, 5_000);
          await interruptKnownTurn();
        },
      );
      return {
        provider: "codex",
        sessionId: transport.sessionId,
        usage,
        beforeTokens: null,
        afterTokens: null,
      };
    } finally {
      if (!stopped) cleanup();
      // A late failed notification must not become an unhandled rejection after cancellation.
      void completed.catch(() => {});
    }
  };
}

export type ClaudeCompactionTransport = {
  sessionId: string;
  /**
   * One transport-owned pump consumes the persistent SDK query. Subscribe only to new messages;
   * unsubscribe removes this listener, never closes that query. Share NativeSessionLifecycle
   * with ordinary turns so each operation owns the next result for this session.
   */
  subscribe(listener: (message: unknown) => void): () => void;
  /** Sends on the configured sandbox-bound session; resolves on acceptance and obeys Stop before dispatch. */
  send(prompt: string, signal?: AbortSignal): Promise<void>;
  interrupt(): Promise<void>;
};
// Nullish, not optional: a model that caches nothing reports `null` here, and a message that
// fails to parse is ignored — which, for the result message, leaves the compaction waiting for
// a completion it was already sent.
const Usage = z.object({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  cache_creation_input_tokens: z.number().nonnegative().nullish(),
  cache_read_input_tokens: z.number().nonnegative().nullish(),
});
const ClaudeMessage = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  session_id: z.string(),
  compact_metadata: z
    .object({
      pre_tokens: z.number().int().nonnegative().optional(),
      post_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  usage: Usage.optional(),
  is_error: z.boolean().optional(),
});

export function claudeCompaction(transport: ClaudeCompactionTransport): NativeCompaction {
  return async (request) => {
    request.signal?.throwIfAborted();
    let boundary = false;
    let beforeTokens: number | null = null;
    let afterTokens: number | null = null;
    let usage: TokenUsage | null = null;
    let resolve = () => {};
    let reject = (_error: Error) => {};
    const completed = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void completed.catch(() => {});
    let sent = false;
    let settled = false;
    const unsubscribe = transport.subscribe((raw) => {
      if (!sent || settled) return;
      const parsed = ClaudeMessage.safeParse(raw);
      if (!parsed.success || parsed.data.session_id !== transport.sessionId) return;
      const message = parsed.data;
      if (message.type === "system" && message.subtype === "compact_boundary") {
        boundary = true;
        beforeTokens = message.compact_metadata?.pre_tokens ?? null;
        afterTokens = message.compact_metadata?.post_tokens ?? null;
      }
      if (message.type === "result") {
        settled = true;
        if (message.subtype !== "success" || message.is_error) {
          reject(new Error("Claude native compaction failed."));
          return;
        }
        if (!boundary) {
          reject(new Error("Claude did not report compact_boundary and successful completion."));
          return;
        }
        if (message.usage !== undefined)
          usage = tokenUsage({
            uncached: message.usage.input_tokens,
            cacheWrite: message.usage.cache_creation_input_tokens,
            cacheRead: message.usage.cache_read_input_tokens,
            output: message.usage.output_tokens,
          });
        resolve();
      }
    });
    try {
      await interruptible(
        async (signal) => {
          signal.throwIfAborted();
          sent = true;
          await transport.send("/compact", signal);
          await completed;
        },
        request.signal,
        () => transport.interrupt(),
      );
    } finally {
      settled = true;
      unsubscribe();
      // Release the command's waiter without touching the transport's persistent iterator.
      resolve();
    }
    return { provider: "claude", sessionId: transport.sessionId, usage, beforeTokens, afterTokens };
  };
}

async function interruptible(
  work: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal | undefined,
  interrupt: () => Promise<void>,
): Promise<void> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const effective =
    signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
  let abort = () => {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => {
      void interrupt().catch(() => {});
      reject(new Error("Native compaction was interrupted; reopen the session before continuing."));
    };
    effective.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => controller.abort(), 120_000);
  });
  try {
    await Promise.race([work(effective), stopped]);
    effective.throwIfAborted();
  } finally {
    clearTimeout(timeout);
    effective.removeEventListener("abort", abort);
  }
}
