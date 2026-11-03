/**
 * Holding a plan mode turn to its one job: ending with a plan (ADR-0024).
 *
 * A turn asked for a plan that stops with a paragraph of findings has left the person with
 * nothing to approve. This refuses that stop once, saying how to end instead. Once, because the
 * honest answer is sometimes that nothing needs to change, and the model saying so is a fine end.
 *
 * It never sees a turn that proposed: `propose_plan` ends the turn before stop hooks are asked.
 */

import type { TurnHook } from "./hook.ts";

export class PlanMode implements TurnHook {
  #refused = false;

  async beforeStop(): Promise<string | undefined> {
    if (this.#refused) return undefined;
    this.#refused = true;
    return "This turn is plan mode: it ends with a plan for the person to approve. Call propose_plan with your plan now, or ask_user if one answer would change it. If the request truly needs no change, say so in one sentence and stop.";
  }
}
