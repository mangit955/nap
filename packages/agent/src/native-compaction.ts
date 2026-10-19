/** Adapted from T3 Code e3b35d1b2440. See THIRD_PARTY_NOTICES.md for its MIT notice. */
import type { LLMTurn, NativeCompaction, TokenUsage } from "@nap/shared/ports/llm-provider";
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
  subscribe(listener: (notification: unknown) => void): () => void;
  interrupt(turnId: string | null): Promise<void>;
};

const CodexNotification = z.object({
  method: z.string(),
  params: z.object({
    threadId: z.string(),
    turnId: z.string().optional(),
    turn: z.object({ id: z.string(), status: z.string().optional() }).optional(),
    item: z.object({ type: z.string() }).optional(),
    tokenUsage: z
      .object({
        total: z.object({
          inputTokens: z.int().nonnegative(),
          outputTokens: z.int().nonnegative(),
        }),
        last: z.object({ inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative() }),
      })
      .optional(),
  }),
});

export function codexCompaction(transport: CodexCompactionTransport): NativeCompaction {
  return async (request) => {
    let turnId: string | null = null;
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
    const unsubscribe = transport.subscribe((raw) => {
      const parsed = CodexNotification.safeParse(raw);
      if (!parsed.success || parsed.data.params.threadId !== transport.sessionId) return;
      const { method, params } = parsed.data;
      if (method === "turn/started") turnId = params.turn?.id ?? null;
      if (method === "thread/tokenUsage/updated" && params.tokenUsage !== undefined) {
        const current = params.tokenUsage.total;
        if (params.turnId === turnId) {
          // Codex totals include cached input already. A repeated notification has zero delta;
          // a missing/reset baseline uses the reported last response, as in T3's accumulator.
          const delta =
            total === undefined ||
            current.inputTokens < total.inputTokens ||
            current.outputTokens < total.outputTokens
              ? params.tokenUsage.last
              : {
                  inputTokens: current.inputTokens - total.inputTokens,
                  outputTokens: current.outputTokens - total.outputTokens,
                };
          usage = {
            inputTokens: (usage?.inputTokens ?? 0) + delta.inputTokens,
            outputTokens: (usage?.outputTokens ?? 0) + delta.outputTokens,
          };
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
          await transport.request("thread/compact/start", { threadId: transport.sessionId });
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
        },
        request.signal,
        () => transport.interrupt(turnId),
      );
      return {
        provider: "codex",
        sessionId: transport.sessionId,
        usage,
        beforeTokens: null,
        afterTokens: null,
      };
    } finally {
      unsubscribe();
      // A late failed notification must not become an unhandled rejection after cancellation.
      void completed.catch(() => {});
    }
  };
}

export type ClaudeCompactionTransport = {
  sessionId: string;
  /** Must use the existing sandbox-bound Agent SDK session and its configured instructions. */
  query(prompt: string, signal?: AbortSignal): AsyncIterable<unknown>;
  interrupt(): Promise<void>;
};
const Usage = z.object({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  cache_creation_input_tokens: z.number().nonnegative().optional(),
  cache_read_input_tokens: z.number().nonnegative().optional(),
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
    let boundary = false;
    let completed = false;
    let beforeTokens: number | null = null;
    let afterTokens: number | null = null;
    let usage: TokenUsage | null = null;
    await interruptible(
      async (signal) => {
        for await (const raw of transport.query("/compact", signal)) {
          signal.throwIfAborted();
          const parsed = ClaudeMessage.safeParse(raw);
          if (!parsed.success || parsed.data.session_id !== transport.sessionId) continue;
          const message = parsed.data;
          if (message.type === "system" && message.subtype === "compact_boundary") {
            boundary = true;
            beforeTokens = message.compact_metadata?.pre_tokens ?? null;
            afterTokens = message.compact_metadata?.post_tokens ?? null;
          }
          if (message.type === "result") {
            if (message.subtype !== "success" || message.is_error)
              throw new Error("Claude native compaction failed.");
            completed = true;
            if (message.usage !== undefined)
              usage = {
                inputTokens:
                  message.usage.input_tokens +
                  (message.usage.cache_creation_input_tokens ?? 0) +
                  (message.usage.cache_read_input_tokens ?? 0),
                outputTokens: message.usage.output_tokens,
              };
          }
        }
        if (!boundary || !completed)
          throw new Error("Claude did not report compact_boundary and successful completion.");
      },
      request.signal,
      () => transport.interrupt(),
    );
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
  } finally {
    clearTimeout(timeout);
    effective.removeEventListener("abort", abort);
  }
}
