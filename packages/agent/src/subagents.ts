/**
 * Helpers: a second, smaller model loop the turn hands a self-contained task to.
 *
 * The reason to have them is context, not speed. Finding where something lives in a large
 * repository is twenty searches and reads whose output the parent needs none of — only the
 * answer. Run in the parent's own conversation, that output is re-sent on every later request of
 * the turn; run in a helper, it is spent once and the parent receives a paragraph.
 *
 * Four rules keep a helper from being a second, unaccountable turn (ADR-0020):
 *
 *  - **It spends the turn's budget.** Every token is recorded against the parent's
 *    `TurnBudget`, so the ceiling that caps a turn's bill still caps it, and a helper may only
 *    use part of what remains so the parent can still act on the answer.
 *  - **It lives inside the turn.** It shares the turn's cancellation, and a background helper
 *    nobody collected is cancelled when the turn ends — nothing runs on after the lease.
 *  - **Its traffic stays out of the log.** Its tool calls would replay into the parent's
 *    conversation as calls the parent never made, which the model API rejects. The log gets a
 *    `subagent.started`, the files it changed, and a `subagent.completed`.
 *  - **It gets fewer tools.** No questions, no plan, no further helpers; `explore` cannot write.
 */

import type { SubagentOutcome, SubagentProfile } from "@nap/shared/agent-plan";
import type { NapEvent, NapEventOf } from "@nap/shared/events";
import type { AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { DistributiveOmit } from "@nap/shared/ports/event-store";
import type {
  LLMContentBlock,
  LLMMessage,
  LLMProvider,
  TokenUsage,
} from "@nap/shared/ports/llm-provider";
import { CANCELLED, stopAware } from "./cancellation.ts";
import type { TurnBudget } from "./safety/budget.ts";
import type { SubagentRunner, ToolOutcome } from "./tools/context.ts";
import { executeTool } from "./tools/execute.ts";
import { FileLedger } from "./tools/ledger.ts";
import { type ModelFamily, toolNamesFor, toolsetFor } from "./tools/toolset.ts";

/** Model requests one helper may make. A search that has not converged by then will not. */
export const SUBAGENT_STEPS: Record<SubagentProfile, number> = { explore: 15, general: 30 };

/** The share of the turn's remaining tokens one helper may spend. */
export const SUBAGENT_BUDGET_SHARE = 0.5;

/** How much of a report the log keeps; the model gets all of it in the tool result. */
const LOGGED_SUMMARY_CHARS = 2_000;

type Request = { toolCallId: string; profile: SubagentProfile; task: string };
type Payload<T extends NapEvent["type"]> = NapEventOf<T>["payload"];

export type SubagentPoolOptions = {
  provider: LLMProvider;
  /** The model each profile runs on. */
  models: Record<SubagentProfile, string | undefined>;
  credentials: AgentTurnRequest["credentials"];
  prompts: Record<SubagentProfile, string>;
  family: ModelFamily;
  budget: TurnBudget;
  request: Pick<AgentTurnRequest, "sessionId" | "turnId" | "sandboxId" | "sandbox" | "signal">;
  /** The turn's event sink. Only what a reader of the log needs reaches it. */
  emit: (event: DistributiveOmit<NapEvent, "seq">) => void;
  now: () => string;
};

type Helper = { report: Promise<ToolOutcome>; controller: AbortController; collected: boolean };

export class SubagentPool implements SubagentRunner {
  readonly #options: SubagentPoolOptions;
  readonly #helpers = new Map<string, Helper>();
  readonly #usage = { inputTokens: 0, outputTokens: 0 };
  #started = 0;

  constructor(options: SubagentPoolOptions) {
    this.#options = options;
  }

  run(request: Request): Promise<ToolOutcome> {
    return this.#execute(this.#nextId(), request, new AbortController());
  }

  start(request: Request): string {
    const subagentId = this.#nextId();
    const controller = new AbortController();
    this.#helpers.set(subagentId, {
      report: this.#execute(subagentId, request, controller),
      controller,
      collected: false,
    });
    return subagentId;
  }

  async collect(subagentId: string): Promise<ToolOutcome> {
    const helper = this.#helpers.get(subagentId);
    if (helper === undefined)
      return { ok: false, output: `No helper ${subagentId} was started in this turn.` };
    helper.collected = true;
    return helper.report;
  }

  /** Background helpers whose report nobody has asked for. */
  uncollected(): string[] {
    return [...this.#helpers].filter(([, helper]) => !helper.collected).map(([id]) => id);
  }

  /** Stops every background helper and waits for each to say so, so none outlives the turn. */
  async settle(): Promise<void> {
    for (const helper of this.#helpers.values()) helper.controller.abort();
    await Promise.all([...this.#helpers.values()].map((helper) => helper.report));
  }

  usage(): TokenUsage {
    return { ...this.#usage };
  }

  /** Unique within the turn, and short, because the model types it back into read_subagent. */
  #nextId(): string {
    this.#started += 1;
    return `helper-${this.#started}`;
  }

  async #execute(
    subagentId: string,
    request: Request,
    controller: AbortController,
  ): Promise<ToolOutcome> {
    const options = this.#options;
    const parent = options.request.signal;
    const signal =
      parent === undefined ? controller.signal : AbortSignal.any([parent, controller.signal]);
    this.#emit({
      type: "subagent.started",
      payload: {
        toolCallId: request.toolCallId,
        subagentId,
        profile: request.profile,
        task: request.task,
      },
    });

    const usage = { inputTokens: 0, outputTokens: 0 };
    let toolCalls = 0;
    const finish = (outcome: SubagentOutcome, report: string): ToolOutcome => {
      this.#emit({
        type: "subagent.completed",
        payload: {
          subagentId,
          outcome,
          summary: report.slice(0, LOGGED_SUMMARY_CHARS),
          toolCalls,
          usage,
        },
      });
      return outcome === "completed"
        ? { ok: true, output: `Report from ${subagentId}:\n${report}` }
        : { ok: false, output: `${subagentId} ${outcome}: ${report}` };
    };

    const toolsetOptions = {
      promptSource: "user" as const,
      family: options.family,
      computer: false,
      subagents: false,
      subagent: request.profile,
    };
    const tools = toolsetFor(toolsetOptions);
    const offered = toolNamesFor(toolsetOptions);
    const ledger = new FileLedger();
    const allowance = Math.floor(options.budget.remaining().tokens * SUBAGENT_BUDGET_SHARE);
    const turn = options.provider.startTurn({
      model: options.models[request.profile],
      credentials: options.credentials,
    });
    const messages: LLMMessage[] = [{ role: "user", content: request.task }];
    const steps = SUBAGENT_STEPS[request.profile];

    for (let step = 1; step <= steps; step += 1) {
      if (signal.aborted) return finish("cancelled", "Stopped before it finished.");
      if (usage.inputTokens + usage.outputTokens >= allowance || !options.budget.check().ok)
        return finish("failed", "Stopped: the turn's budget cannot cover more of this search.");
      if (step === steps)
        appendText(
          messages,
          "This is your last request. Reply with your report now, from what you have found.",
        );

      const completed = await stopAware(
        turn.complete({
          systemPrompt: options.prompts[request.profile],
          messages: [...messages],
          tools,
          signal,
        }),
        signal,
      );
      if (completed === CANCELLED) return finish("cancelled", "Stopped before it finished.");
      const result = completed;
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      this.#usage.inputTokens += result.usage.inputTokens;
      this.#usage.outputTokens += result.usage.outputTokens;
      options.budget.recordUsage(result.usage);

      if (signal.aborted) return finish("cancelled", "Stopped before it finished.");
      if (result.type === "refusal") return finish("failed", "The model declined this task.");
      if (result.type === "error") return finish("failed", result.message);
      if (result.toolCalls.length === 0)
        return finish("completed", result.text === "" ? "(no report)" : result.text);

      const results: LLMContentBlock[] = [];
      for (const call of result.toolCalls) {
        toolCalls += 1;
        const outcome = await executeTool(call, {
          sessionId: options.request.sessionId,
          turnId: options.request.turnId,
          sandboxId: options.request.sandboxId,
          sandbox: options.request.sandbox,
          signal,
          offered,
          ledger,
          // A helper's own calls stay out of the log; the files it changed do not.
          emit: (event) => {
            if (event.type === "file.changed") options.emit(event);
          },
          now: options.now,
        });
        results.push({
          type: "tool_result",
          toolCallId: call.id,
          content: outcome.output,
          isError: !outcome.ok,
        });
      }
      const assistant: LLMContentBlock[] = result.toolCalls.map((call) => ({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.input,
      }));
      if (result.text !== "") assistant.unshift({ type: "text", text: result.text });
      messages.push({ role: "assistant", content: assistant }, { role: "user", content: results });
    }
    return finish("failed", "Ran out of steps before reporting.");
  }

  #emit<T extends NapEvent["type"]>(event: { type: T; payload: Payload<T> }): void {
    this.#options.emit({
      ...event,
      sessionId: this.#options.request.sessionId,
      turnId: this.#options.request.turnId,
      createdAt: this.#options.now(),
    } as DistributiveOmit<NapEvent, "seq">);
  }
}

/** Adds text to the last user message, so it never splits a result from its request. */
export function appendText(messages: LLMMessage[], text: string): void {
  const last = messages.at(-1);
  if (last === undefined || last.role !== "user") {
    messages.push({ role: "user", content: text });
    return;
  }
  const blocks: LLMContentBlock[] =
    typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
  blocks.push({ type: "text", text });
  messages[messages.length - 1] = { role: "user", content: blocks };
}
