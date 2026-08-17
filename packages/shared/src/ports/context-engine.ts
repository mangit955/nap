/**
 * Assembles what the model sees, and owns the context token budget.
 *
 * It does not call the model and does not decide when a turn ends — it produces a
 * system prompt and a message list, and nothing more. `estimatedTokens` is part of the
 * output because the budget is this component's responsibility: a caller should be able
 * to assert the budget was respected without re-deriving it.
 */

import type { StoredEvent } from "./event-store.ts";
import type { LLMMessage } from "./llm-provider.ts";
import type { MemoryProvider } from "./memory-provider.ts";
import type { SandboxManager } from "./sandbox-manager.ts";

/**
 * A verification failure the job has already seen.
 *
 * The field that earns its keep is `output`: telling a model *what the checks said the last
 * time it tried* is the difference between a second attempt and a repeat of the first. It is
 * the same data `verification.completed` carries, narrowed to what a prompt can use.
 */
export type FailedAttempt = {
  /** The check that said no, as the project names it — `typecheck`, `test`, `preview`. */
  check: string;
  /** Why, in a few words: the exit code, usually. */
  detail: string;
  /** What it printed, already budgeted by whoever ran it. `null` when it failed silently. */
  output: string | null;
};

/**
 * The job this turn belongs to, as far as the prompt is concerned.
 *
 * Handed in like `history` is, and for the same reason: the component that owns the token
 * budget must not also own a fold over the event log. The caller has the log; this is what it
 * adds up to (`@nap/shared/job-state`, docs/adr/0006).
 */
export type JobContext = {
  /** What was asked, as the prompt that opened the job put it. */
  objective: string;
  /**
   * Verification failures already seen on this job, oldest first.
   *
   * Empty on the turn that opens a job. On a repair turn the last entry is the failure being
   * repaired now, and the ones before it are attempts that have already been made and did not
   * work — which is the half of this the model cannot derive for itself.
   */
  attempts: readonly FailedAttempt[];
};

export type ContextRequest = {
  sessionId: string;
  sandboxId: string;
  /** The message this turn is being built for. */
  userMessage: string;
  /**
   * The job this turn belongs to, when the caller tracks one. Absent for a caller that does
   * not — the assembled prompt is then exactly what it was before jobs existed.
   */
  job?: JobContext;
  /**
   * Everything that has already happened in this session, oldest first.
   *
   * Handed in rather than read here, because the caller already holds the event log and an
   * assembler that performs no I/O is one whose truncation behaviour can be driven by a
   * literal array. The alternative — taking an `EventStore` — would make the component that
   * owns the token budget also own a database round trip, and would put a fake store in the
   * path of every test about which messages survive a budget.
   */
  history: StoredEvent[];
  sandbox: SandboxManager;
  memory: MemoryProvider;
};

export type BuiltContext = {
  systemPrompt: string;
  messages: LLMMessage[];
  /** What the assembled context is expected to cost. Never exceeds the budget. */
  estimatedTokens: number;
};

export interface ContextEngine {
  build(request: ContextRequest): Promise<BuiltContext>;
}
