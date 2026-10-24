import { estimateContextTokens } from "@nap/shared/compaction";
import { pruneComputerImages } from "@nap/shared/computer-context";
/**
 * Driving the model through one turn.
 *
 * A turn is not one request. The model asks for tools, reads what they returned, and asks
 * again; the loop here is what turns that exchange into a single unit of work with one
 * `turn.started` at the front and exactly one terminal event at the end.
 *
 * Three properties are worth more than the rest of this file.
 *
 * **A round trip's tool results go back together.** A single assistant message can carry
 * several tool calls, and answering them in separate user messages is accepted by the API
 * while quietly teaching the model to stop asking for tools in parallel. So the batch is
 * executed, then every result is appended in one user message — failures included, because
 * a tool call without its answering result is rejected outright.
 *
 * **The turn ends once.** Every branch below either emits `turn.completed` or emits
 * `turn.failed`, never both and never neither. Anything replaying a session sees an open
 * turn for exactly as long as the turn was open.
 *
 * **Nothing here is persisted, committed, or torn down.** Events leave through `onEvent`
 * without a `seq`; the commit sha in `turn.completed` comes from a caller-supplied hook.
 * The caller that owns those things is the runtime — see `docs/PLAN.md` §0.
 */

import type { NapEvent, NapEventOf, TurnFailureReason } from "@nap/shared/events";
import { modelSupportsImages } from "@nap/shared/model-capabilities";
import type { AgentService, AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type {
  LLMContentBlock,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMToolCall,
  LLMTurn,
  LLMTurnResult,
} from "@nap/shared/ports/llm-provider";
import { DeltaStream } from "./delta-stream.ts";
import { TurnBudget, type TurnBudgetOptions } from "./safety/budget.ts";
import { APP_TEST_TOOL_NAMES, TOOL_DEFINITIONS } from "./tools/definitions.ts";
import { executeTool, type ToolContext } from "./tools/execute.ts";

type Payload<T extends NapEvent["type"]> = NapEventOf<T>["payload"];
const CANCELLED = Symbol("cancelled");

export type AgentServiceOptions = {
  provider: LLMProvider;
  /** Per-turn ceilings. Defaults come from ./safety/budget.ts. */
  budget?: TurnBudgetOptions;
  testBudget?: TurnBudgetOptions;
  /** Injected so a test can assert on whole events rather than on everything but the clock. */
  now?: () => string;
  /** Injected for the same reason, for the duration `turn.completed` reports. */
  clock?: () => number;
};

export class NapAgentService implements AgentService {
  readonly #provider: LLMProvider;
  readonly #budget: TurnBudgetOptions;
  readonly #testBudget: TurnBudgetOptions;
  readonly #now: () => string;
  readonly #clock: () => number;

  constructor(options: AgentServiceOptions) {
    this.#provider = options.provider;
    this.#budget = options.budget ?? {};
    this.#testBudget = { maxSteps: 30, maxTokens: 160_000, ...options.testBudget };
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#clock = options.clock ?? (() => Date.now());
  }

  async runTurn(request: AgentTurnRequest): Promise<void> {
    await new Turn(
      request,
      this.#provider,
      request.promptSource === "test" ? this.#testBudget : this.#budget,
      this.#now,
      this.#clock,
    ).run();
  }
}

/**
 * One turn's state, so nothing about a turn lives on the service.
 *
 * Two turns can be in flight at once — the runtime serializes them per session, not per
 * process — and a loop keeping its message list or its budget on `this` of a shared
 * service would let them corrupt each other silently.
 */
class Turn {
  readonly #request: AgentTurnRequest;
  readonly #turn: LLMTurn;
  readonly #budget: TurnBudget;
  readonly #now: () => string;
  readonly #clock: () => number;
  readonly #startedAt: number;
  readonly #messages: LLMMessage[];
  readonly #tools: typeof TOOL_DEFINITIONS;
  #lastCompactionStep = -3;
  #reportedInput: number | undefined;
  #inputEstimate = 0;
  #nativeContext = false;
  #nativeUsage = { inputTokens: 0, outputTokens: 0 };
  #usageIncomplete = false;

  constructor(
    request: AgentTurnRequest,
    provider: LLMProvider,
    budget: TurnBudgetOptions,
    now: () => string,
    clock: () => number,
  ) {
    this.#request = request;
    this.#tools = TOOL_DEFINITIONS.filter(
      (tool) =>
        (request.promptSource !== "test" ||
          APP_TEST_TOOL_NAMES.some((name) => name === tool.name)) &&
        (tool.name !== "computer" ||
          (request.computer !== undefined && modelSupportsImages(request.model))),
    );
    this.#turn = provider.startTurn({
      model: request.model,
      credentials: request.credentials,
    });
    this.#budget = new TurnBudget(budget);
    this.#now = now;
    this.#startedAt = clock();
    this.#clock = clock;
    this.#messages = pruneComputerImages(request.context.messages, 0);
  }

  async run(): Promise<void> {
    this.#emit({
      type: "turn.started",
      payload: { source: this.#request.promptSource ?? "user" },
    });

    if (this.#request.operation === "compact") {
      if (this.#cancelled()) return this.#fail("cancelled", "The turn was cancelled.");
      const result = await this.#compact("manual");
      if (!result.ok)
        return this.#fail(this.#cancelled() ? "cancelled" : "internal", result.message);
      return this.#complete();
    }

    for (;;) {
      if (this.#cancelled()) return this.#fail("cancelled", "The turn was cancelled.");

      const contextFailure = await this.#checkContext();
      if (this.#cancelled()) return this.#fail("cancelled", "The turn was cancelled.");
      if (contextFailure !== undefined) return this.#fail("internal", contextFailure);
      const input = this.#estimate();
      if (
        (this.#request.context.budgetTokens !== undefined &&
          input > this.#request.context.budgetTokens) ||
        (this.#turn.contextWindowTokens !== undefined &&
          input + this.#headroom() >= this.#turn.contextWindowTokens)
      )
        return this.#fail(
          "budget_exceeded",
          "The context is full. Compaction could not make enough room while preserving your instructions.",
        );
      if (
        this.#request.context.budgetTokens !== undefined &&
        input > this.#budget.remaining().tokens
      )
        return this.#fail(
          "budget_exceeded",
          "The remaining turn budget cannot cover the next model request.",
        );
      this.#budget.recordStep();
      const stepBudget = this.#budget.check();
      if (!stepBudget.ok) return this.#failWith(stepBudget.failure);

      // One per step, because a step is one stream. Its buffer is flushed the moment the
      // call returns and before any branch below can leave the loop, so the last thought of
      // a turn survives whichever way that turn ended — a refusal and an upstream failure
      // are the two cases where the reasoning is the only account of what happened.
      const thinking = new DeltaStream((text) => {
        if (!this.#cancelled()) this.#emit({ type: "agent.thinking", payload: { text } });
      });

      // The answer's prose, on its own stream. `wrote` is what decides whether the assembled
      // text is emitted afterwards: a model or a route that sends no text deltas would
      // otherwise say nothing at all, and one that sends them would say everything twice.
      let wrote = false;
      const prose = new DeltaStream((text) => {
        if (this.#cancelled()) return;
        wrote = true;
        this.#emit({ type: "agent.message", payload: { text } });
      });

      // The provider receives the signal too, but a proxy or upstream stream can take a while
      // to honour it. Racing here ends our turn immediately, preventing further tool calls or
      // streamed output while the transport tears itself down in the background.
      const completed = await stopAware(
        this.#turn.complete({
          systemPrompt: this.#request.context.systemPrompt,
          messages: [...this.#messages],
          tools: this.#tools,
          onThinkingDelta: (delta) => thinking.push(delta),
          onTextDelta: (delta) => prose.push(delta),
          ...(this.#request.signal === undefined ? {} : { signal: this.#request.signal }),
        }),
        this.#request.signal,
      );

      if (completed === CANCELLED || this.#cancelled()) {
        return this.#fail("cancelled", "The turn was cancelled.");
      }
      const result = completed;
      this.#budget.recordUsage(result.usage);
      this.#reportedInput = result.usage.inputTokens > 0 ? result.usage.inputTokens : undefined;
      this.#inputEstimate = estimateContextTokens({
        systemPrompt: this.#request.context.systemPrompt,
        messages: this.#messages,
        tools: this.#tools,
      });
      if (this.#request.context.budgetTokens !== undefined)
        this.#emit({
          type: "context.usage",
          payload: {
            inputTokens: this.#reportedInput ?? this.#inputEstimate,
            source: this.#reportedInput === undefined ? "estimated" : "reported",
            budgetTokens: this.#request.context.budgetTokens,
            windowTokens: this.#turn.contextWindowTokens ?? null,
          },
        });

      thinking.flush();
      prose.flush();

      if (result.type === "refusal") {
        return this.#fail("refusal", "The model declined to answer this request.");
      }
      if (result.type === "error") {
        // `retryable` here means the provider *already* retried and the model was still not
        // there — a throttle or an overload, which is a different sentence to the user than
        // something in this system going wrong.
        return this.#fail(result.retryable ? "model_unavailable" : "internal", result.message);
      }

      const tokenBudget = this.#budget.check();
      if (!tokenBudget.ok) return this.#failWith(tokenBudget.failure);

      // Only when the prose did not already arrive in pieces. The assembled text is the same
      // words the deltas carried, so emitting it as well would print the answer twice.
      if (!wrote && result.text !== "") {
        this.#emit({ type: "agent.message", payload: { text: result.text } });
      }

      if (result.toolCalls.length === 0) return await this.#complete();

      const cancelled = await this.#runTools(result.text, result.toolCalls);
      if (cancelled) return this.#fail("cancelled", "The turn was cancelled.");
    }
  }

  #estimate(): number {
    const estimate = estimateContextTokens({
      systemPrompt: this.#request.context.systemPrompt,
      messages: this.#messages,
      tools: this.#tools,
    });
    const calibrated = (this.#reportedInput ?? 0) + estimate - this.#inputEstimate;
    return this.#nativeContext && this.#reportedInput !== undefined
      ? Math.max(0, calibrated)
      : Math.max(estimate, calibrated);
  }

  #headroom(): number {
    return Math.min(
      8_192,
      Math.floor(
        Math.min(
          this.#request.context.budgetTokens ?? Number.POSITIVE_INFINITY,
          this.#turn.contextWindowTokens ?? Number.POSITIVE_INFINITY,
        ) / 5,
      ),
    );
  }

  async #checkContext(): Promise<string | undefined> {
    const ceiling = this.#request.context.budgetTokens;
    if (ceiling === undefined) return;
    const input = this.#estimate();
    this.#emit({
      type: "context.usage",
      payload: {
        inputTokens: input,
        source: "estimated",
        budgetTokens: ceiling,
        windowTokens: this.#turn.contextWindowTokens ?? null,
      },
    });
    const available = this.#budget.remaining();
    const headroom = this.#headroom();
    const windowPressure =
      this.#turn.contextWindowTokens !== undefined &&
      input + headroom >= this.#turn.contextWindowTokens;
    const repeatedCost =
      input >= 24_000 && input * Math.min(3, available.steps) > available.tokens / 2;
    const pressure =
      input + headroom >= ceiling ||
      windowPressure ||
      repeatedCost ||
      (this.#request.context.needsCompaction && this.#budget.spent().steps === 0);
    if (
      pressure &&
      (input >= ceiling ||
        windowPressure ||
        this.#budget.spent().steps - this.#lastCompactionStep >= 3) &&
      available.steps > 1
    ) {
      const result = await this.#compact("automatic");
      if (!result.ok && this.#turn.compact !== undefined) return result.message;
    }
    return undefined;
  }

  async #compact(
    trigger: "manual" | "automatic",
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    this.#lastCompactionStep = this.#budget.spent().steps;
    if (this.#request.compactContext === undefined)
      return { ok: false, message: "Context compaction is unavailable for this session." };
    const complete = async (request: LLMRequest): Promise<LLMTurnResult> => {
      const estimate = estimateContextTokens(request);
      const remaining = this.#budget.remaining();
      const reserve = trigger === "automatic" ? 4_096 : 0;
      if (
        remaining.steps <= (trigger === "automatic" ? 1 : 0) ||
        estimate + (request.maxOutputTokens ?? 4_096) + reserve > remaining.tokens
      )
        throw new Error("Not enough turn budget remains for compaction and continuation.");
      if (
        estimate + (request.maxOutputTokens ?? 4_096) >
        (this.#turn.contextWindowTokens ?? Number.POSITIVE_INFINITY)
      )
        throw new Error("The compaction request exceeds this model's context window.");
      this.#budget.recordStep();
      const result = await stopAware(this.#turn.complete(request), this.#request.signal);
      if (result === CANCELLED) throw new Error("Compaction cancelled.");
      this.#budget.recordUsage(result.usage);
      return result;
    };
    const native = this.#turn.compact;
    const result = await this.#request.compactContext({
      messages: this.#messages,
      tools: this.#tools,
      systemPrompt: this.#request.context.systemPrompt,
      trigger,
      complete,
      signal: this.#request.signal,
      native:
        native === undefined
          ? undefined
          : async (request) => {
              const reserve = this.#estimate() + 4_096;
              if (this.#budget.remaining().tokens < reserve || this.#budget.remaining().steps < 1)
                throw new Error("Not enough turn budget remains for native compaction.");
              this.#budget.recordStep();
              let result: Awaited<ReturnType<typeof native>>;
              try {
                result = await native({
                  ...request,
                  trustedInstructions:
                    this.#request.context.trustedInstructions ?? request.trustedInstructions,
                  untrustedContext: JSON.stringify({
                    workingContext: request.trustedInstructions,
                    conversation: request.untrustedContext,
                  }),
                });
              } catch (error) {
                // No refund for a native command whose outcome/cost was not delivered.
                this.#budget.recordUsage({ inputTokens: reserve, outputTokens: 0 });
                throw error;
              }
              this.#budget.recordUsage(result.usage ?? { inputTokens: reserve, outputTokens: 0 });
              if (result.usage !== null) {
                this.#nativeUsage.inputTokens += result.usage.inputTokens;
                this.#nativeUsage.outputTokens += result.usage.outputTokens;
              } else this.#usageIncomplete = true;
              return result;
            },
    });
    this.#lastCompactionStep = this.#budget.spent().steps;
    if (result.ok) {
      this.#messages.splice(0, this.#messages.length, ...pruneComputerImages(result.messages));
      this.#nativeContext = native !== undefined;
      this.#reportedInput = result.contextTokens;
      this.#inputEstimate =
        result.contextTokens === undefined
          ? 0
          : estimateContextTokens({
              systemPrompt: this.#request.context.systemPrompt,
              messages: this.#messages,
              tools: this.#tools,
            });
      if (this.#request.context.budgetTokens !== undefined)
        this.#emit({
          type: "context.usage",
          payload: {
            inputTokens: this.#estimate(),
            source: result.contextTokens === undefined ? "estimated" : "reported",
            budgetTokens: this.#request.context.budgetTokens,
            windowTokens: this.#turn.contextWindowTokens ?? null,
          },
        });
    }
    const verdict = this.#budget.check();
    if (!verdict.ok) return { ok: false, message: verdict.failure.message };
    return result;
  }

  /**
   * Executes a batch of tool calls and appends both halves of the exchange.
   *
   * Returns whether the turn was cancelled part-way. The results collected so far are
   * deliberately *not* sent: the conversation is being abandoned, and a user message
   * answering only some of an assistant message's tool calls is a request the API rejects.
   */
  async #runTools(text: string, calls: readonly LLMToolCall[]): Promise<boolean> {
    const results: LLMContentBlock[] = [];

    for (const call of calls) {
      if (this.#cancelled()) return true;

      const outcome = await executeTool(call, this.#toolContext());
      results.push({
        type: "tool_result",
        toolCallId: call.id,
        content: outcome.content ?? outcome.output,
        // A failed tool is a result the model reads and works around, never a dropped block.
        isError: !outcome.ok,
      });
    }

    const assistant: LLMContentBlock[] = calls.map((call) => ({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
    }));
    if (text !== "") assistant.unshift({ type: "text", text });

    this.#messages.push({ role: "assistant", content: assistant });
    // Every result in one message: see the note at the top of this file.
    this.#messages.push({ role: "user", content: results });
    this.#messages.splice(0, this.#messages.length, ...pruneComputerImages(this.#messages));

    return false;
  }

  async #complete(): Promise<void> {
    // Awaited before the event rather than after, so a turn is never reported done while
    // the work it did is still uncommitted.
    const finalized = await this.#request.finalize?.();

    this.#emit({
      type: "turn.completed",
      payload: {
        ...(this.#usageIncomplete ? { usageIncomplete: true as const } : {}),
        usage: {
          inputTokens: this.#turn.usage().inputTokens + this.#nativeUsage.inputTokens,
          outputTokens: this.#turn.usage().outputTokens + this.#nativeUsage.outputTokens,
        },
        durationMs: this.#clock() - this.#startedAt,
        commitSha: finalized?.commitSha ?? null,
      },
    });
  }

  #cancelled(): boolean {
    return this.#request.signal?.aborted === true;
  }

  #fail(reason: TurnFailureReason, message: string): void {
    this.#failWith({ reason, message });
  }

  #failWith(failure: Payload<"turn.failed">): void {
    this.#emit({ type: "turn.failed", payload: failure });
  }

  #toolContext(): ToolContext {
    return {
      sessionId: this.#request.sessionId,
      turnId: this.#request.turnId,
      sandboxId: this.#request.sandboxId,
      sandbox: this.#request.sandbox,
      testMode: this.#request.promptSource === "test",
      computer: modelSupportsImages(this.#request.model) ? this.#request.computer : undefined,
      signal: this.#request.signal,
      emit: this.#request.onEvent,
      now: this.#now,
    };
  }

  /**
   * Written as a generic over the discriminated union so `type` and `payload` stay
   * correlated — the pair is the whole contract.
   */
  #emit<T extends NapEvent["type"]>(event: { type: T; payload: Payload<T> }): void {
    this.#request.onEvent({
      ...event,
      sessionId: this.#request.sessionId,
      turnId: this.#request.turnId,
      createdAt: this.#now(),
    } as PendingEvent);
  }
}

/** Resolves promptly on abort even if an upstream streaming request is slow to settle. */
function stopAware<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof CANCELLED> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.resolve(CANCELLED);

  return new Promise((resolve, reject) => {
    const stopped = () => resolve(CANCELLED);
    signal.addEventListener("abort", stopped, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stopped));
  });
}
