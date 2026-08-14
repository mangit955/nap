/**
 * A `ContextEngine` that assembles nothing worth reading.
 *
 * For tests about what happens *around* the context — the runtime's ordering, its logging, its
 * snapshots — where a real assembly would be a second subject. It records what it was asked for,
 * because "the turn's own message is not also in the history" is a rule the runtime owns and this
 * is where a test can see the inputs it passed.
 *
 * By default it echoes the turn's message back as the one user message: the smallest context that
 * is still true to the request. A test that needs a particular shape passes one.
 */

import type { BuiltContext, ContextEngine, ContextRequest } from "@nap/shared/ports/context-engine";

export class StubContextEngine implements ContextEngine {
  /** Every request, in order, for the tests that assert on what the runtime passed down. */
  readonly requests: ContextRequest[] = [];

  constructor(private readonly context?: BuiltContext) {}

  async build(request: ContextRequest): Promise<BuiltContext> {
    this.requests.push(request);

    return (
      this.context ?? {
        systemPrompt: "system",
        messages: [{ role: "user", content: request.userMessage }],
        estimatedTokens: 3,
      }
    );
  }
}
