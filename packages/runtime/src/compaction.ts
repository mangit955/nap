import { prepareCompaction, summaryRequest } from "@nap/context/compaction";
import { type CompactContext, estimateContextTokens } from "@nap/shared/compaction";
import type { NapEvent, NapEventOf } from "@nap/shared/events";
import type { BuiltContext } from "@nap/shared/ports/context-engine";
import type { TokenUsage } from "@nap/shared/ports/llm-provider";

/** Called only while the runtime owns the session lease, between complete tool batches. */
type CompactionEvent = {
  [T in "compaction.started" | "compaction.completed" | "compaction.failed"]: {
    type: T;
    payload: NapEventOf<T>["payload"];
  };
}["compaction.started" | "compaction.completed" | "compaction.failed"];

export function contextCompactor(options: {
  read: () => Promise<NapEvent[]>;
  emit: (event: CompactionEvent) => void;
  drain: () => Promise<void>;
  rebuild: (history: NapEvent[]) => Promise<BuiltContext>;
  budgetTokens: number;
}): CompactContext {
  return async (request) => {
    const id = crypto.randomUUID();
    let usage: TokenUsage | null =
      request.native === undefined ? { inputTokens: 0, outputTokens: 0 } : null;
    options.emit({ type: "compaction.started", payload: { id, trigger: request.trigger } });
    await options.drain();
    try {
      request.signal?.throwIfAborted();
      const history = await options.read();
      if (request.native !== undefined) {
        const result = await request.native({
          trustedInstructions: request.systemPrompt,
          untrustedContext: JSON.stringify({
            userRequests: history
              .filter((event) => event.type === "user.message")
              .map((event) => event.payload),
            recentExchange: request.messages.slice(-2),
          }),
          signal: request.signal,
        });
        usage = result.usage;
        request.signal?.throwIfAborted();
        options.emit({
          type: "compaction.completed",
          payload: {
            id,
            result: {
              kind: "native",
              provider: result.provider,
              sessionId: result.sessionId,
              coveredThrough: history.at(-1)?.seq ?? 0,
            },
            usage,
            beforeTokens: result.beforeTokens,
            afterTokens: result.afterTokens,
          },
        });
        await options.drain();
        return {
          ok: true,
          messages: request.messages,
          ...(result.afterTokens === null ? {} : { contextTokens: result.afterTokens }),
        };
      }
      const outputTokens = Math.min(4_096, Math.max(256, Math.floor(options.budgetTokens / 10)));
      // JSON quoting can double a fragment's size. Reserve for it, the running summary,
      // instructions and output, rather than assuming chars/4 is a provider window.
      const plan = prepareCompaction(
        history,
        Math.max(128, Math.floor((options.budgetTokens - outputTokens * 2 - 2_000) / 3)),
      );
      if (plan === null) throw new Error("There is no complete conversation to compact yet.");
      let summary = "";
      for (const chunk of plan.chunks) {
        request.signal?.throwIfAborted();
        const result = await request.complete({
          ...summaryRequest(chunk, summary, outputTokens),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        usage = {
          inputTokens: (usage?.inputTokens ?? 0) + result.usage.inputTokens,
          outputTokens: (usage?.outputTokens ?? 0) + result.usage.outputTokens,
        };
        if (result.type !== "message")
          throw new Error(
            result.type === "error"
              ? result.message
              : "The model declined to summarize this conversation.",
          );
        if (result.truncated || result.toolCalls.length > 0 || result.text.trim() === "")
          throw new Error(
            "The model did not return a complete summary. Previous context was kept.",
          );
        summary = result.text.trim();
      }
      request.signal?.throwIfAborted();
      const checkpoint = { coveredThrough: plan.coveredThrough, summary, tail: plan.tail };
      const beforeTokens = estimateContextTokens({
        systemPrompt: request.systemPrompt,
        messages: request.messages,
        tools: request.tools,
      });
      const last = history.at(-1);
      if (last === undefined) throw new Error("No session history is available.");
      const completed: NapEventOf<"compaction.completed"> = {
        ...last,
        seq: last.seq + 1,
        type: "compaction.completed",
        payload: {
          id,
          result: { kind: "api", checkpoint },
          usage,
          beforeTokens,
          afterTokens: null,
        },
      };
      const rebuilt = await options.rebuild([...history, completed]);
      const afterTokens = estimateContextTokens({
        systemPrompt: request.systemPrompt,
        messages: rebuilt.messages,
        tools: request.tools,
      });
      // A manual request may summarize history that initial pruning had already hidden.
      // For automatic runs, keep the known usable context if the summary made it larger.
      if (
        afterTokens >= options.budgetTokens ||
        (request.trigger === "automatic" && afterTokens >= beforeTokens)
      )
        throw new Error(
          "Compaction could not make enough room while preserving your instructions. Previous context was kept.",
        );
      request.signal?.throwIfAborted();
      options.emit({
        type: "compaction.completed",
        payload: { ...completed.payload, afterTokens },
      });
      await options.drain();
      return { ok: true, messages: rebuilt.messages };
    } catch (error) {
      const cancelled = request.signal?.aborted === true;
      if (cancelled) usage = null;
      const message = cancelled
        ? request.native === undefined
          ? "Compaction cancelled. Previous context was kept."
          : "Native compaction interrupted. Reopen the native session before continuing."
        : error instanceof Error
          ? error.message
          : String(error);
      options.emit({ type: "compaction.failed", payload: { id, message, cancelled, usage } });
      await options.drain();
      return { ok: false, message };
    }
  };
}
