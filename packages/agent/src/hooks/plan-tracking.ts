/**
 * Keeping the visible checklist honest.
 *
 * A plan the person is watching is a promise about what happens next, and the two ways it
 * breaks are both quiet: the model stops updating it halfway through, or ends the turn with
 * items still open and says nothing about them. This hook nudges once for each — a reminder
 * after a long stretch without an update, and one refusal to stop while items are open. Once,
 * because an item can be open for a good reason, and the model saying so is the right outcome.
 */

import { type PlanItem, PlanSchema } from "@nap/shared/agent-plan";
import type { LLMToolCall } from "@nap/shared/ports/llm-provider";
import type { ToolOutcome } from "../tools/context.ts";
import type { TurnHook } from "./hook.ts";

/** Model requests without a plan update before the model is reminded it has one. */
export const STALE_PLAN_STEPS = 10;

export class PlanTracking implements TurnHook {
  #plan: PlanItem[] = [];
  #updatedAt = 0;
  #step = 0;
  #reminded = false;
  #refusedStop = false;

  beforeModel(step: number): string | undefined {
    this.#step = step;
    if (this.#reminded || this.#open().length === 0) return undefined;
    if (step - this.#updatedAt < STALE_PLAN_STEPS) return undefined;
    this.#reminded = true;
    return "Your plan has not changed in a while. If progress has moved on, update it with todo_write so the person watching sees where things stand.";
  }

  async afterTool(call: LLMToolCall, outcome: ToolOutcome): Promise<ToolOutcome> {
    if (call.name !== "todo_write" || !outcome.ok) return outcome;
    const plan = PlanSchema.safeParse(call.input.todos);
    if (plan.success) {
      this.#plan = plan.data;
      this.#updatedAt = this.#step;
      this.#reminded = false;
    }
    return outcome;
  }

  async beforeStop(): Promise<string | undefined> {
    const open = this.#open();
    if (this.#refusedStop || open.length === 0) return undefined;
    this.#refusedStop = true;
    return `Your plan still has ${open.length} unfinished ${open.length === 1 ? "item" : "items"}: ${open.map((item) => `"${item.content}"`).join(", ")}. Finish them, or update the plan and say why they are not being done, before you end the turn.`;
  }

  #open(): PlanItem[] {
    return this.#plan.filter((item) => item.status !== "completed");
  }
}
