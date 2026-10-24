import type { TurnFailureReason } from "../events.ts";
import type { NativeAgentTurnRequest } from "./agent-service.ts";
import type { StoredEvent } from "./event-store.ts";
import type { TokenUsage } from "./llm-provider.ts";
import type { ProcessExit } from "./sandbox-process.ts";

export type NativeExecutionInput = Pick<
  NativeAgentTurnRequest,
  "target" | "userId" | "projectId" | "sessionId" | "turnId" | "sandboxId" | "input" | "operation"
> & { lease: NonNullable<NativeAgentTurnRequest["lease"]> };
export type NativeWriteBarrier = { kind: "confirmed"; agent: ProcessExit; writers: ProcessExit[] };
export type NativeExecutionResult =
  | {
      kind: "completed";
      usage: TokenUsage | null;
      usageIncomplete: boolean;
      quiescence: NativeWriteBarrier;
    }
  | {
      kind: "failed";
      reason: TurnFailureReason;
      message: string;
      quiescence: NativeWriteBarrier | { kind: "not_started" | "unconfirmed" };
    };
export interface NativeTurnExecutor {
  run(
    input: NativeExecutionInput,
    options: { signal?: AbortSignal | undefined; publish: (event: StoredEvent) => Promise<void> },
  ): Promise<NativeExecutionResult>;
}

/** A fenced workspace cannot enter repository finalization, snapshotting or automatic repair. */
export class NativeWorkspaceFencedError extends Error {
  constructor() {
    super(
      "Native termination is unconfirmed. The workspace remains fenced until its processes are verified stopped.",
    );
  }
}
