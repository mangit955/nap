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
import type { AgentService, AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type {
  LLMContentBlock,
  LLMMessage,
  LLMProvider,
  LLMToolCall,
  LLMTurn,
} from "@nap/shared/ports/llm-provider";
import { DeltaStream } from "./delta-stream.ts";
import { TurnBudget, type TurnBudgetOptions } from "./safety/budget.ts";
import { TOOL_DEFINITIONS } from "./tools/definitions.ts";
import { executeTool, type ToolContext } from "./tools/execute.ts";

type Payload<T extends NapEvent["type"]> = NapEventOf<T>["payload"];
const CANCELLED = Symbol("cancelled");

export type AgentServiceOptions = {
  provider: LLMProvider;
  /** Per-turn ceilings. Defaults come from ./safety/budget.ts. */
  budget?: TurnBudgetOptions;
  /** Injected so a test can assert on whole events rather than on everything but the clock. */
  now?: () => string;
  /** Injected for the same reason, for the duration `turn.completed` reports. */
  clock?: () => number;
};

export class NapAgentService implements AgentService {
  readonly #provider: LLMProvider;
  readonly #budget: TurnBudgetOptions;
  readonly #now: () => string;
  readonly #clock: () => number;

  constructor(options: AgentServiceOptions) {
    this.#provider = options.provider;
    this.#budget = options.budget ?? {};
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#clock = options.clock ?? (() => Date.now());
  }

  async runTurn(request: AgentTurnRequest): Promise<void> {
    await new Turn(request, this.#provider, this.#budget, this.#now, this.#clock).run();
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

  constructor(
    request: AgentTurnRequest,
    provider: LLMProvider,
    budget: TurnBudgetOptions,
    now: () => string,
    clock: () => number,
  ) {
    this.#request = request;
    this.#turn = provider.startTurn({
      model: request.model,
      credentials: request.credentials,
    });
    this.#budget = new TurnBudget(budget);
    this.#now = now;
    this.#startedAt = clock();
    this.#clock = clock;
    this.#messages = [...request.context.messages];
  }

  async run(): Promise<void> {
    this.#emit({
      type: "turn.started",
      payload: { source: this.#request.promptSource ?? "user" },
    });

    for (;;) {
      if (this.#cancelled()) return this.#fail("cancelled", "The turn was cancelled.");

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
          messages: this.#messages,
          tools: TOOL_DEFINITIONS,
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

      this.#budget.recordUsage(result.usage);
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
        content: outcome.output,
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

    return false;
  }

  async #complete(): Promise<void> {
    // Awaited before the event rather than after, so a turn is never reported done while
    // the work it did is still uncommitted.
    const finalized = await this.#request.finalize?.();

    this.#emit({
      type: "turn.completed",
      payload: {
        usage: this.#turn.usage(),
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
