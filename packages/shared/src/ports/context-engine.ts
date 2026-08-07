/**
 * Assembles what the model sees, and owns the context token budget.
 *
 * It does not call the model and does not decide when a turn ends — it produces a
 * system prompt and a message list, and nothing more. `estimatedTokens` is part of the
 * output because the budget is this component's responsibility: a caller should be able
 * to assert the budget was respected without re-deriving it.
 */

import type { LLMMessage } from "./llm-provider.ts";
import type { MemoryProvider } from "./memory-provider.ts";
import type { SandboxManager } from "./sandbox-manager.ts";

export type ContextRequest = {
  sessionId: string;
  sandboxId: string;
  /** The message this turn is being built for. */
  userMessage: string;
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
