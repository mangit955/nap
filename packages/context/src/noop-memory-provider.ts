/**
 * The v1 `MemoryProvider`: it remembers nothing, on purpose.
 *
 * Long-term memory is out of scope for v1, but the *call sites* are not. `ContextEngine`
 * asks for memories and interpolates them when there are any, and the runtime hands every
 * finished turn's events to `write` — all of that is real code, running today, against an
 * implementation that does nothing with it. Turning memory on later is then a change of
 * implementation rather than a change of shape, which is the whole reason this class
 * exists (docs/PLAN.md §0, and the "Long-term memory" row of its v2 table).
 *
 * So: do not delete this because its methods are empty, and do not make it clever.
 * Anything it retained would be memory nobody designed, appearing in prompts nobody
 * expected. Its tests assert the emptiness in both directions — that `retrieve` returns
 * nothing, and that a consumer given this provider produces byte-identical output to one
 * given no provider at all.
 *
 * `retrieve` returns `[]` rather than anything nullable so callers never have to
 * null-check the seam; a caller that has to is a caller that will one day interpolate
 * `undefined` into a prompt.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";
import type { Memory, MemoryProvider } from "@nap/shared/ports/memory-provider";

export class NoopMemoryProvider implements MemoryProvider {
  async retrieve(_sessionId: string, _query: string): Promise<Memory[]> {
    return [];
  }

  async write(_sessionId: string, _events: StoredEvent[]): Promise<void> {
    // Deliberately empty: see the note above.
  }
}
