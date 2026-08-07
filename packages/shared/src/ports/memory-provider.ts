/**
 * Long-term memory. Inert in v1 — the no-op implementation returns nothing and stores
 * nothing — but the call sites are real from the start.
 *
 * This is the seam that makes v2's memory additive: `ContextEngine` already asks for
 * memories and already interpolates them when present, so turning memory on is a change
 * of implementation rather than a change of shape.
 */

import type { StoredEvent } from "./event-store.ts";

export type Memory = {
  id: string;
  /** The remembered content, ready to interpolate into a prompt. */
  content: string;
  /** Higher is more relevant to the query that retrieved it. */
  score: number;
};

export interface MemoryProvider {
  retrieve(sessionId: string, query: string): Promise<Memory[]>;
  write(sessionId: string, events: StoredEvent[]): Promise<void>;
}
