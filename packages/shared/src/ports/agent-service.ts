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
  /**
   * Which model to run this turn on. Absent is the deployment's default.
   *
   * Validated long before it arrives here — the route checks it against an allowlist, because
   * an unchecked model id from a request body is somebody else spending your money.
   */
  model?: string | undefined;
  /**
   * Run after the model stops, before the turn is reported complete.
   *
   * `turn.completed` carries the commit its changes landed in, but committing is the
   * caller's job — so the caller supplies a closure and this component awaits it. That is
   * what lets the event hold a real sha without git appearing anywhere in the agent: the
   * only alternative was to always report `null`, which the event contract reads as "the
   * turn changed no files".
   *
   * Absent, the turn completes with no commit, which is what a caller that does not
   * version the workspace means.
   */
  finalize?: () => Promise<{ commitSha: string | null }>;
};

export interface AgentService {
  runTurn(request: AgentTurnRequest): Promise<void>;
}
