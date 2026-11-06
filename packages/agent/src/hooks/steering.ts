/**
 * Hands the model what the person sent while the turn ran (ADR-0026).
 *
 * The hook is the whole of steering inside the agent, and it is small on purpose. Where a steer
 * waits, how it reaches this process, and recording where it was read all belong to the runtime,
 * which is behind `take`; how it reads to the model belongs to the context engine, which is behind
 * `render`. What is left here is *when* — and that is the loop's, through the `interject` seam.
 */

import type { AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { TurnHook } from "./hook.ts";

export class Steering implements TurnHook {
  readonly #inbox: NonNullable<AgentTurnRequest["steering"]>;
  readonly #render: (text: string) => string;

  constructor(inbox: NonNullable<AgentTurnRequest["steering"]>, render: (text: string) => string) {
    this.#inbox = inbox;
    this.#render = render;
  }

  async interject(): Promise<readonly string[]> {
    const steers = await this.#inbox.take();
    return steers.map((steer) => this.#render(steer.text));
  }
}
