/**
 * An `AgentService` that emits a fixed list of events instead of driving a model.
 *
 * The runtime's job is what happens *around* the agent — acquiring a sandbox, persisting,
 * publishing, committing, photographing — so the agent is scripted here for the same reason the
 * model is scripted a layer below in `ScriptedLLMProvider`: a test that also has to make a model
 * behave is asserting on two things at once.
 *
 * The script is a function rather than an array so a test can decide what the turn emits *at the
 * moment it runs* — a `turn.completed` carries the sha that `finalize` just produced, and that is
 * not known when the agent is built.
 */

import type { AgentService, AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { PendingEvent } from "@nap/shared/ports/event-store";

/** A turn as the events it emits. Deliberately loose: tests script malformed turns on purpose. */
export type AgentScript = (
  request: AgentTurnRequest,
) => { type: string; payload: unknown }[] | Promise<{ type: string; payload: unknown }[]>;

export class ScriptedAgent implements AgentService {
  /** Every request the runtime made, for tests asserting on what it passed down. */
  readonly requests: AgentTurnRequest[] = [];

  constructor(private readonly script: AgentScript) {}

  get calls(): number {
    return this.requests.length;
  }

  async runTurn(request: AgentTurnRequest): Promise<void> {
    this.requests.push(request);

    for (const event of await this.script(request)) {
      request.onEvent({
        ...event,
        sessionId: request.sessionId,
        turnId: request.turnId,
        createdAt: "2026-01-01T00:00:00.000Z",
      } as PendingEvent);
    }
  }
}

/** The two events an ordinary turn ends with. */
export function completedTurn(commitSha: string | null) {
  return [
    { type: "turn.started", payload: {} },
    {
      type: "turn.completed",
      payload: { usage: { inputTokens: 10, outputTokens: 2 }, durationMs: 5, commitSha },
    },
  ];
}
