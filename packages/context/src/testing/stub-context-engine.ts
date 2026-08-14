/**
 * A `ContextEngine` that assembles nothing.
 *
 * For tests about what happens *around* the context — the runtime's ordering, its logging, its
 * snapshots — where a real assembly would be a second subject. It records what it was asked for,
 * because "the turn's own message is not also in the history" is a rule the runtime owns and this
 * is where a test can see the inputs it passed.
 */

import type { BuiltContext, ContextEngine, ContextRequest } from "@nap/shared/ports/context-engine";

export class StubContextEngine implements ContextEngine {
  /** Every request, in order, for the tests that assert on what the runtime passed down. */
  readonly requests: ContextRequest[] = [];

  constructor(private readonly context: BuiltContext = EMPTY) {}

  async build(request: ContextRequest): Promise<BuiltContext> {
    this.requests.push(request);
    return this.context;
  }
}

const EMPTY: BuiltContext = { systemPrompt: "", messages: [], estimatedTokens: 0 };

/** A context that carries the turn's message, for tests that want the agent to see something. */
export function contextOf(userMessage: string): BuiltContext {
  return {
    systemPrompt: "system",
    messages: [{ role: "user", content: userMessage }],
    estimatedTokens: 3,
  };
}
