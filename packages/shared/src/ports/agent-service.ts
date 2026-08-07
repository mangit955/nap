/**
 * Drives the model loop for exactly one turn.
 *
 * It streams, executes the sandbox-proxy tools, and emits typed events. It does not
 * persist anything, touch git, manage sandbox lifecycle, or assemble prompts — those
 * belong to the `Runtime` and the `ContextEngine` respectively.
 *
 * Events go out through `onEvent` without a `seq`: sequence numbers come from the
 * `EventStore`, and an emitter that invented its own would break replay ordering.
 */

import type { BuiltContext } from "./context-engine.ts";
import type { PendingEvent } from "./event-store.ts";
import type { SandboxManager } from "./sandbox-manager.ts";

export type AgentTurnRequest = {
  sessionId: string;
  turnId: string;
  sandboxId: string;
  context: BuiltContext;
  sandbox: SandboxManager;
  /** Called for each event as it happens, before it has been persisted. */
  onEvent: (event: PendingEvent) => void;
  /** Cancellation mid-turn must stop tool execution, not just ignore the result. */
  signal?: AbortSignal;
};

export interface AgentService {
  runTurn(request: AgentTurnRequest): Promise<void>;
}
