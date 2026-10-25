import type {
  AgentRunResult,
  AgentService,
  AgentTurnRequest,
  NativeAgentTurnRequest,
} from "@nap/shared/ports/agent-service";
import type { DistributiveOmit, PendingEvent } from "@nap/shared/ports/event-store";
import type {
  NativeExecutionResult,
  NativeTurnExecutor,
} from "@nap/shared/ports/native-turn-executor";

type Terminal = DistributiveOmit<
  Extract<PendingEvent, { type: "turn.started" | "turn.failed" | "turn.completed" }>,
  "sessionId" | "turnId" | "createdAt"
>;

/** API turns retain their loop; subscription turns enter exactly one native executor. */
export class NativeAgentService implements AgentService {
  constructor(
    private readonly options: {
      api: AgentService;
      executor?: NativeTurnExecutor;
      now?: () => string;
      clock?: () => number;
    },
  ) {}

  async runTurn(request: AgentTurnRequest): Promise<AgentRunResult> {
    if (request.kind !== "native") return this.options.api.runTurn(request);
    const started = this.options.clock?.() ?? Date.now();
    this.#emit(request, {
      type: "turn.started",
      payload: { source: request.promptSource ?? "user" },
    });
    await request.drain();
    if (this.options.executor === undefined || request.lease === null) {
      this.#emit(request, {
        type: "turn.failed",
        payload: {
          reason: "model_unavailable",
          message: "This subscription's native runtime is unavailable. No API request was made.",
        },
      });
      return;
    }
    let result: NativeExecutionResult;
    try {
      result = await this.options.executor.run(
        {
          target: request.target,
          userId: request.userId,
          projectId: request.projectId,
          sessionId: request.sessionId,
          turnId: request.turnId,
          sandboxId: request.sandboxId,
          input: request.input,
          lease: request.lease,
          ...(request.operation === undefined ? {} : { operation: request.operation }),
        },
        {
          signal: request.signal,
          publish: async (event) => {
            if (event.sessionId !== request.sessionId || event.turnId !== request.turnId)
              throw new Error("Native event ownership mismatch");
            request.onStoredEvent(event);
            await request.drain();
          },
        },
      );
    } catch {
      return this.#fence(request);
    }
    if (
      result.quiescence.kind === "unconfirmed" ||
      (result.quiescence.kind === "confirmed" &&
        (result.quiescence.agent.containment !== "cgroup" ||
          result.quiescence.writers.some((writer) => writer.containment !== "cgroup")))
    )
      return this.#fence(request);
    if (result.kind === "failed") {
      this.#emit(request, {
        type: "turn.failed",
        payload: { reason: result.reason, message: result.message },
      });
      return;
    }
    if (request.signal?.aborted) {
      this.#emit(request, {
        type: "turn.failed",
        payload: { reason: "cancelled", message: "The turn was cancelled." },
      });
      return;
    }
    await request.drain();
    const finalized = await request.finalize?.();
    this.#emit(request, {
      type: "turn.completed",
      payload: {
        usage: result.usage ?? { inputTokens: 0, outputTokens: 0 },
        ...(result.usageIncomplete || result.usage === null
          ? { usageIncomplete: true as const }
          : {}),
        durationMs: Math.max(0, Math.round((this.options.clock?.() ?? Date.now()) - started)),
        commitSha: finalized?.commitSha ?? null,
      },
    });
  }

  #fence(request: NativeAgentTurnRequest): AgentRunResult {
    this.#emit(request, {
      type: "turn.failed",
      payload: {
        reason: "internal",
        message:
          "Native termination could not be confirmed. The workspace remains fenced; execution was not retried.",
      },
    });
    return { kind: "workspace_fenced" };
  }
  #emit(request: NativeAgentTurnRequest, event: Terminal): void {
    request.onEvent({
      ...event,
      sessionId: request.sessionId,
      turnId: request.turnId,
      createdAt: this.options.now?.() ?? new Date().toISOString(),
    });
  }
}
