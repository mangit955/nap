/**
 * An `AgentService` that emits a fixed list of events instead of driving a model.
 *
 * The runtime's job is what happens *around* the agent — acquiring a sandbox, persisting,
 * publishing, committing, photographing — so the agent is scripted here for the same reason the
 * model is scripted a layer below in `ScriptedLLMProvider`: a test that also has to make a model
 * behave is asserting on two things at once.
 *
 * The script is a function of the request rather than an array, because what a turn emits depends
 * on what it was given — a `turn.completed` carries the sha that `finalize` just produced, and
 * that is not known when the agent is built.
 */

import type { NapEventType } from "@nap/shared/events";
import type { AgentService, AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { PendingEvent } from "@nap/shared/ports/event-store";

/** A turn as the events it emits. Deliberately loose: tests script malformed turns on purpose. */
export type AgentScript = (request: AgentTurnRequest) => { type: NapEventType; payload: unknown }[];

export class ScriptedAgent implements AgentService {
  /** Every request the runtime made, for tests asserting on what it passed down. */
  readonly requests: AgentTurnRequest[] = [];

  /**
   * Runs before the scripted events, so a test can hold a turn open — which is how the
   * per-session queue is driven — or throw from inside one.
   */
  before?: (request: AgentTurnRequest) => Promise<void>;

  constructor(
    private readonly script: AgentScript = () => [{ type: "turn.started", payload: {} }],
    /**
     * Whether to call the runtime's `finalize` hook and report the sha it returns.
     *
     * Off by default because most tests are about something else, and committing is the one step
     * a scripted agent can accidentally skip while still looking like a turn that worked.
     */
    private readonly finalizes = false,
  ) {}

  get calls(): number {
    return this.requests.length;
  }

  async runTurn(request: AgentTurnRequest): Promise<void> {
    this.requests.push(request);
    await this.before?.(request);

    for (const event of this.script(request)) {
      if (event.type === "turn.completed" && this.finalizes) {
        const finalized = await request.finalize?.();
        request.onEvent(
          completed(request, { commitSha: finalized?.commitSha ?? null }) as PendingEvent,
        );
        continue;
      }

      request.onEvent({
        ...event,
        sessionId: request.sessionId,
        turnId: request.turnId,
        createdAt: FIXED_TIME,
      } as PendingEvent);
    }
  }
}

const FIXED_TIME = "2026-01-01T00:00:00.000Z";

function completed(request: AgentTurnRequest, over: { commitSha: string | null }) {
  return {
    type: "turn.completed",
    sessionId: request.sessionId,
    turnId: request.turnId,
    createdAt: FIXED_TIME,
    payload: { usage: { inputTokens: 1, outputTokens: 2 }, durationMs: 5, ...over },
  };
}

/**
 * The events an ordinary turn ends with.
 *
 * A real payload rather than `{}`: the emit site casts to `PendingEvent`, which once laundered an
 * invalid event past the type system, and nothing read the fields until a turn's cost started
 * being logged — at which point every test on this script failed at once.
 */
export function completedTurn(commitSha: string | null) {
  return [
    { type: "turn.started" as const, payload: {} },
    {
      type: "turn.completed" as const,
      payload: { usage: { inputTokens: 10, outputTokens: 2 }, durationMs: 5, commitSha },
    },
  ];
}
