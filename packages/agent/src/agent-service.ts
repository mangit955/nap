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

import type { SubagentProfile } from "@nap/shared/agent-plan";
import type { NapEvent, NapEventOf, ToolName, TurnFailureReason } from "@nap/shared/events";
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
import { CANCELLED, pause, stopAware } from "./cancellation.ts";
import { DeltaStream } from "./delta-stream.ts";
import { DirectoryRules } from "./hooks/directory-rules.ts";
import type { TurnHook } from "./hooks/hook.ts";
import { PlanTracking } from "./hooks/plan-tracking.ts";
import { TurnBudget, type TurnBudgetOptions } from "./safety/budget.ts";
import { appendText, SubagentPool } from "./subagents.ts";
import type { ToolDefinition } from "./tools/definitions.ts";
import { runsConcurrently } from "./tools/definitions.ts";
import { executeTool, type ToolContext, type ToolOutcome } from "./tools/execute.ts";
import { FileLedger } from "./tools/ledger.ts";
import { modelFamily, toolNamesFor, toolsetFor } from "./tools/toolset.ts";

type Payload<T extends NapEvent["type"]> = NapEventOf<T>["payload"];

/** How long to wait before asking a model the provider already gave up on once more. */
export const DEFAULT_RETRY_DELAY_MS = 20_000;

/** How many times one turn may answer a reply cut off at the output limit by asking for more. */
export const MAX_TRUNCATION_RECOVERIES = 2;

/** How many times stop hooks may keep one turn going. Two, so no hook can keep it alive. */
export const MAX_STOP_REFUSALS = 2;

export type AgentServiceOptions = {
  provider: LLMProvider;
  /** Per-turn ceilings. Defaults come from ./safety/budget.ts. */
  budget?: TurnBudgetOptions;
  testBudget?: TurnBudgetOptions;
  /** Injected so a test can assert on whole events rather than on everything but the clock. */
  now?: () => string;
  /** Injected for the same reason, for the duration `turn.completed` reports. */
  clock?: () => number;
  /**
   * A model to continue on when the turn's own model refuses, already on the deployment's
   * allowlist. Used only when the deployment is paying: a person's own key may not reach it.
   */
  fallbackModel?: string | undefined;
  /**
   * What each helper profile runs on when the deployment is paying. Absent, or on a person's own
   * key, a helper runs on the turn's model — the only one that key is known to reach.
   */
  subagentModels?: Partial<Record<SubagentProfile, string>> | undefined;
  /** How long a transient model failure waits before one more attempt. */
  retryDelayMs?: number;
  /** Further hooks, after the built-in ones. For a composition, and for tests. */
  hooks?: ((request: AgentTurnRequest) => TurnHook[]) | undefined;
};

export class NapAgentService implements AgentService {
  readonly #options: AgentServiceOptions;
  readonly #budget: TurnBudgetOptions;
  readonly #testBudget: TurnBudgetOptions;
  readonly #now: () => string;
  readonly #clock: () => number;

  constructor(options: AgentServiceOptions) {
    this.#options = options;
    this.#budget = options.budget ?? {};
    this.#testBudget = { maxSteps: 30, maxTokens: 160_000, ...options.testBudget };
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#clock = options.clock ?? (() => Date.now());
  }

  async runTurn(request: AgentTurnRequest): Promise<void> {
    await new Turn(
      request,
      this.#options,
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
  readonly #options: AgentServiceOptions;
  /** Replaced only by a fallback after a refusal; every turn it has been is in `#turns`. */
  #turn: LLMTurn;
  readonly #turns: LLMTurn[] = [];
  readonly #budget: TurnBudget;
  readonly #now: () => string;
  readonly #clock: () => number;
  readonly #startedAt: number;
  readonly #messages: LLMMessage[];
  #model: string | undefined;
  #tools: ToolDefinition[];
  #offered: ReadonlySet<ToolName>;
  readonly #ledger = new FileLedger();
  readonly #hooks: TurnHook[];
  readonly #helpers: SubagentPool | undefined;
  #retried = false;
  #fellBack = false;
  #truncations = 0;
  #stopRefusals = 0;
  #helpersAsked = false;
  #lastCompactionStep = -3;
  #reportedInput: number | undefined;
  #inputEstimate = 0;
  #nativeContext = false;
  #nativeUsage = { inputTokens: 0, outputTokens: 0 };
  #usageIncomplete = false;

  constructor(
    request: AgentTurnRequest,
    options: AgentServiceOptions,
    budget: TurnBudgetOptions,
    now: () => string,
    clock: () => number,
  ) {
    this.#request = request;
    this.#options = options;
    this.#model = request.model;
    const prompts = request.context.subagentPrompts;
    const toolset = this.#toolsetOptions();
    this.#tools = toolsetFor(toolset);
    this.#offered = toolNamesFor(toolset);
    this.#turn = options.provider.startTurn({
      model: request.model,
      credentials: request.credentials,
    });
    this.#turns.push(this.#turn);
    this.#budget = new TurnBudget(budget);
    this.#now = now;
    this.#startedAt = clock();
    this.#clock = clock;
    this.#messages = pruneComputerImages(request.context.messages, 0);

    // A cheaper helper model is the deployment's to choose and the deployment's to pay for;
    // on a person's own key the turn's model is the only one known to be reachable.
    const deploymentPays = request.credentials === undefined;
    this.#helpers =
      prompts === undefined || !this.#offered.has("run_subagent")
        ? undefined
        : new SubagentPool({
            provider: options.provider,
            modelFor: (profile) =>
              (deploymentPays ? options.subagentModels?.[profile] : undefined) ?? this.#model,
            credentials: request.credentials,
            prompts,
            rootRules: request.context.rootRules === true,
            budget: this.#budget,
            request,
            emit: request.onEvent,
            now,
          });

    this.#hooks = [
      new DirectoryRules({
        sandbox: request.sandbox,
        sandboxId: request.sandboxId,
        includeRoot: request.context.rootRules === true,
      }),
      ...(this.#offered.has("todo_write") ? [new PlanTracking()] : []),
      ...(options.hooks?.(request) ?? []),
    ];
  }

  async run(): Promise<void> {
    try {
      await this.#run();
    } finally {
      await this.#helpers?.settle();
    }
  }

  async #run(): Promise<void> {
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
        input > (this.#helpers?.availableTokens() ?? this.#budget.remaining().tokens)
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

      const reminders = this.#hooks.flatMap(
        (hook) => hook.beforeModel?.(this.#budget.spent().steps) ?? [],
      );
      if (reminders.length > 0)
        appendText(
          this.#messages,
          reminders.map((text) => `<reminder>${text}</reminder>`).join("\n"),
        );

      // The helper pool owns outstanding promises. Include reminders in this estimate and
      // bound the parent's output too, so a concurrent request cannot spend those promises.
      const maxOutputTokens =
        this.#helpers === undefined
          ? undefined
          : Math.floor(this.#helpers.availableTokens() - this.#estimate());
      if (maxOutputTokens !== undefined && maxOutputTokens < 1)
        return this.#fail(
          "budget_exceeded",
          "The unpromised turn budget cannot cover the next model request.",
        );

      // The provider receives the signal too, but a proxy or upstream stream can take a while
      // to honour it. Racing here ends our turn immediately, preventing further tool calls or
      // streamed output while the transport tears itself down in the background.
      const messages = [...this.#messages];
      const completed = await stopAware(
        this.#turn.complete({
          systemPrompt: this.#request.context.systemPrompt,
          messages,
          tools: this.#tools,
          ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
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
        if (this.#fallBack()) continue;
        return this.#fail("refusal", "The model declined to answer this request.");
      }
      if (result.type === "error") {
        // `retryable` here means the provider *already* retried and the model was still not
        // there — a throttle or an overload, which is a different sentence to the user than
        // something in this system going wrong. The provider's waits are seconds, sized for a
        // dropped connection; a throttled minute needs one longer wait, once.
        if (result.retryable && !this.#retried) {
          this.#retried = true;
          this.#notice("The model is busy. Trying again shortly.");
          const waited = await pause(
            this.#options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
            this.#request.signal,
          );
          if (!waited) return this.#fail("cancelled", "The turn was cancelled.");
          continue;
        }
        return this.#fail(result.retryable ? "model_unavailable" : "internal", result.message);
      }

      this.#delivered(messages);

      const tokenBudget = this.#budget.check();
      if (!tokenBudget.ok) return this.#failWith(tokenBudget.failure);

      // Only when the prose did not already arrive in pieces. The assembled text is the same
      // words the deltas carried, so emitting it as well would print the answer twice.
      if (!wrote && result.text !== "") {
        this.#emit({ type: "agent.message", payload: { text: result.text } });
      }

      if (result.toolCalls.length === 0) {
        // A reply cut off at the output limit is not an answer. Asking for the rest costs one
        // step; ending the turn there leaves a half-written file or a sentence that stops.
        if (result.truncated === true && this.#truncations < MAX_TRUNCATION_RECOVERIES) {
          this.#truncations += 1;
          this.#continueWith(
            result.text,
            "Your reply was cut off at the output limit. Continue from where it stopped. If you were writing a large file, write it in smaller pieces.",
          );
          continue;
        }
        const objection = await this.#objection();
        if (objection !== undefined) {
          this.#continueWith(result.text, objection);
          continue;
        }
        return await this.#complete();
      }

      const disposition = await this.#runTools(result.text, result.toolCalls);
      if (disposition === "fatal") return;
      if (disposition === "cancelled") return this.#fail("cancelled", "The turn was cancelled.");
      if (disposition === "ended") return await this.#complete();
    }
  }

  /**
   * Why the turn should not end yet, from the first stop hook that has a reason — or nothing.
   * Bounded per turn, so a hook can delay the end but never prevent it.
   */
  async #objection(): Promise<string | undefined> {
    if (this.#stopRefusals >= MAX_STOP_REFUSALS || this.#budget.remaining().steps < 2) return;
    const pending = this.#helpersAsked ? [] : (this.#helpers?.uncollected() ?? []);
    if (pending.length > 0) this.#helpersAsked = true;
    const reason =
      pending.length > 0
        ? `Helpers ${pending.join(", ")} are still working. Collect their reports with read_subagent before you finish; anything not collected is stopped when the turn ends.`
        : await this.#firstStopReason();
    if (reason !== undefined) this.#stopRefusals += 1;
    return reason;
  }

  async #firstStopReason(): Promise<string | undefined> {
    for (const hook of this.#hooks) {
      const reason = await hook.beforeStop?.();
      if (reason !== undefined) return reason;
    }
    return undefined;
  }

  /** Puts the model's reply in the conversation and answers it, so the loop can go round again. */
  #continueWith(reply: string, answer: string): void {
    // An assistant message may not be empty, and one that ended without a word still happened.
    this.#messages.push({ role: "assistant", content: reply === "" ? "(no reply)" : reply });
    this.#messages.push({ role: "user", content: `<reminder>${answer}</reminder>` });
  }

  /**
   * Moves the turn to the fallback model after a refusal, at most once, and only on the
   * deployment's account. Says so in the platform's voice: the person should know which model
   * wrote what follows.
   */
  #fallBack(): boolean {
    const fallback = this.#options.fallbackModel;
    if (
      this.#fellBack ||
      fallback === undefined ||
      fallback === this.#request.model ||
      this.#request.credentials !== undefined ||
      (!modelSupportsImages(fallback) &&
        this.#messages.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some(
              (block) =>
                block.type === "image" ||
                (block.type === "tool_result" &&
                  Array.isArray(block.content) &&
                  block.content.some((observation) => observation.type === "image")),
            ),
        ))
    )
      return false;
    this.#fellBack = true;
    this.#model = fallback;
    this.#turn = this.#options.provider.startTurn({ model: fallback });
    this.#turns.push(this.#turn);
    const toolset = this.#toolsetOptions();
    this.#tools = toolsetFor(toolset);
    this.#offered = toolNamesFor(toolset);
    this.#notice(`The selected model declined this request, so ${fallback} is continuing it.`);
    return true;
  }

  #notice(text: string): void {
    this.#emit({ type: "system.notice", payload: { level: "info", text } });
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

  #delivered(messages: readonly LLMMessage[]): void {
    this.#request.computer?.delivered?.(
      messages.flatMap((message) =>
        typeof message.content === "string"
          ? []
          : message.content.flatMap((block) =>
              block.type === "tool_result" &&
              Array.isArray(block.content) &&
              block.content.some((child) => child.type === "image")
                ? [block.toolCallId]
                : [],
            ),
      ),
    );
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
      const availableTokens = this.#helpers?.availableTokens() ?? remaining.tokens;
      const reserve = trigger === "automatic" ? 4_096 : 0;
      if (
        remaining.steps <= (trigger === "automatic" ? 1 : 0) ||
        estimate + (request.maxOutputTokens ?? 4_096) + reserve > availableTokens
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
      if (result.type === "message") this.#delivered(request.messages);
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
              if (
                (this.#helpers?.availableTokens() ?? this.#budget.remaining().tokens) < reserve ||
                this.#budget.remaining().steps < 1
              )
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
      for (const hook of this.#hooks) hook.compacted?.();
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
   * Consecutive calls that change nothing run at once; anything that writes, runs a command or
   * talks to the person runs alone, in the order the model asked. A concurrent group's events
   * are held and written in call order once the group is done, so the log reads exactly as if
   * the calls had run one after another — every `tool.call` directly followed by its own
   * output and result — and nothing replaying a session has to untangle two calls at once.
   *
   * Returns why an incomplete batch stopped. The results collected so far are
   * deliberately not sent: the conversation is being abandoned, and a user message
   * answering only some of an assistant message's tool calls is a request the API rejects.
   */
  async #runTools(
    text: string,
    calls: readonly LLMToolCall[],
  ): Promise<"continue" | "cancelled" | "fatal" | "ended"> {
    const outcomes: ToolOutcome[] = [];

    for (const group of batches(calls)) {
      if (this.#cancelled()) return "cancelled";

      if (group.length === 1) {
        const [call] = group;
        if (call === undefined) continue;
        outcomes.push(await this.#runOne(call, this.#toolContext()));
      } else {
        const held = group.map(() => [] as PendingEvent[]);
        const settled = await Promise.all(
          group.map((call, index) =>
            this.#runOne(call, {
              ...this.#toolContext(),
              emit: (event) => held[index]?.push(event as PendingEvent),
            }),
          ),
        );
        for (const events of held) for (const event of events) this.#request.onEvent(event);
        outcomes.push(...settled);
      }

      if (outcomes.some((outcome) => outcome.stop === "computer_unsettled")) {
        await this.#fail(
          this.#cancelled() ? "cancelled" : "sandbox_unavailable",
          "Computer input recovery is pending.",
        );
        return "fatal";
      }
    }

    const results: LLMContentBlock[] = calls.map((call, index) => {
      const outcome = outcomes[index] ?? { ok: false, output: "The call did not run." };
      return {
        type: "tool_result",
        toolCallId: call.id,
        content: outcome.content ?? outcome.output,
        // A failed tool is a result the model reads and works around, never a dropped block.
        isError: !outcome.ok,
      };
    });

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

    return outcomes.some((outcome) => outcome.endsTurn === true) ? "ended" : "continue";
  }

  /** One call, then every hook's say on what the model is told about it. */
  async #runOne(call: LLMToolCall, ctx: ToolContext): Promise<ToolOutcome> {
    let outcome = await executeTool(call, ctx);
    for (const hook of this.#hooks) {
      if (hook.afterTool === undefined) continue;
      const amended = await hook.afterTool(call, outcome);
      // A hook adds words. It may not turn a failure into a success or the reverse, and it may
      // not touch the images, which earn a verdict only by reaching the model unaltered.
      outcome = { ...outcome, output: amended.output };
    }
    return outcome;
  }

  async #complete(): Promise<void> {
    // Helpers nobody collected stop here, before the commit, so nothing they do lands after it.
    await this.#helpers?.settle();
    // Awaited before the event rather than after, so a turn is never reported done while
    // the work it did is still uncommitted.
    const finalized = await this.#request.finalize?.();
    const helpers = this.#helpers?.usage() ?? { inputTokens: 0, outputTokens: 0 };

    this.#emit({
      type: "turn.completed",
      payload: {
        ...(this.#usageIncomplete || this.#helpers?.usageIncomplete()
          ? { usageIncomplete: true as const }
          : {}),
        usage: {
          inputTokens:
            this.#modelUsage().inputTokens + this.#nativeUsage.inputTokens + helpers.inputTokens,
          outputTokens:
            this.#modelUsage().outputTokens + this.#nativeUsage.outputTokens + helpers.outputTokens,
        },
        durationMs: this.#clock() - this.#startedAt,
        commitSha: finalized?.commitSha ?? null,
      },
    });
  }

  /** Every model this turn ran on, since a fallback is billed as well as the model it replaced. */
  #modelUsage(): { inputTokens: number; outputTokens: number } {
    return this.#turns.reduce(
      (sum, turn) => ({
        inputTokens: sum.inputTokens + turn.usage().inputTokens,
        outputTokens: sum.outputTokens + turn.usage().outputTokens,
      }),
      { inputTokens: 0, outputTokens: 0 },
    );
  }

  #cancelled(): boolean {
    return this.#request.signal?.aborted === true;
  }

  #fail(reason: TurnFailureReason, message: string): Promise<void> {
    return this.#failWith({ reason, message });
  }

  async #failWith(failure: Payload<"turn.failed">): Promise<void> {
    await this.#helpers?.settle();
    this.#emit({ type: "turn.failed", payload: failure });
  }

  #toolContext(): ToolContext {
    return {
      sessionId: this.#request.sessionId,
      turnId: this.#request.turnId,
      sandboxId: this.#request.sandboxId,
      sandbox: this.#request.sandbox,
      testMode: this.#request.promptSource === "test",
      offered: this.#offered,
      ledger: this.#ledger,
      subagents: this.#helpers,
      computer: modelSupportsImages(this.#model) ? this.#request.computer : undefined,
      signal: this.#request.signal,
      emit: this.#request.onEvent,
      now: this.#now,
    };
  }

  #toolsetOptions() {
    return {
      promptSource: this.#request.promptSource ?? "user",
      family: modelFamily(this.#model),
      computer: this.#request.computer !== undefined && modelSupportsImages(this.#model),
      subagents: this.#request.context.subagentPrompts !== undefined,
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

/**
 * Splits a batch into runs that may execute together: consecutive calls that change nothing
 * form one group, and every other call is a group of its own.
 */
function batches(calls: readonly LLMToolCall[]): LLMToolCall[][] {
  const groups: LLMToolCall[][] = [];
  for (const call of calls) {
    const last = groups.at(-1);
    const concurrent = runsConcurrently(call.name, call.input);
    if (
      concurrent &&
      last !== undefined &&
      runsConcurrently(last[0]?.name ?? "", last[0]?.input ?? {})
    )
      last.push(call);
    else groups.push([call]);
  }
  return groups;
}
