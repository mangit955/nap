/**
 * What a session has spent on models, read from its log.
 *
 * Several events carry a `usage`, but they do not add up: some record calls that were made inside
 * a turn, on the turn's own provider, and so are already in that turn's `turn.completed`. Adding
 * those again would bill the person twice on paper. Each usage-bearing event is therefore listed
 * below with whether the session's total counts it, and an event that gains a `usage` does not
 * compile until somebody decides.
 */

import type { NapEvent } from "./events.ts";
import { addUsage, type TokenUsage } from "./usage.ts";

/**
 * Every event type whose payload has a `usage` field.
 *
 * Matches a `usage` key at all, optional or not: `Extract` against `{ usage: unknown }` skips an
 * optional one, and optional is how events usually grow a field. An empty payload's `keyof` is
 * `string`, which would otherwise match every key name.
 */
export type UsageEventType = NapEvent extends infer E
  ? E extends { type: infer T; payload: infer P }
    ? string extends keyof P
      ? never
      : "usage" extends keyof P
        ? T
        : never
    : never
  : never;

/**
 * Whether the session's total adds each one.
 *
 * Not a compaction or a helper: both run on the turn's provider, and when the turn completes,
 * `turn.completed` already adds their tokens to the turn's (`AgentService`, where the turn
 * completes). When the turn fails instead, their own events are the only record of what they
 * spent, and this total leaves them out with the rest of that turn.
 */
const COUNTED: Record<UsageEventType, boolean> = {
  "turn.completed": true,
  // A title is a model call outside any turn, recorded on the project's newest session.
  "project.renamed": true,
  // A review runs after its turn has completed.
  "review.completed": true,
  "subagent.completed": false,
  "compaction.completed": false,
  "compaction.failed": false,
};

/**
 * The tokens a session's completed turns, titles and reviews spent.
 *
 * Not everything the log records: a failed turn writes no total of its own, so neither its model
 * calls nor the compaction and helper usage it did record are in this total.
 */
export function sessionUsage(events: readonly NapEvent[]): TokenUsage {
  let total: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  for (const event of events)
    if (carriesUsage(event) && COUNTED[event.type] && event.payload.usage !== null)
      total = addUsage(total, event.payload.usage);
  return total;
}

/**
 * Whether the event has a `usage`. The WebSocket uses it to strip the cache split for an old tab,
 * and since it reads the same table, an event that gains a `usage` cannot miss that either.
 */
export function carriesUsage<E extends Pick<NapEvent, "type">>(
  event: E,
): event is Extract<E, { type: UsageEventType }> {
  return Object.hasOwn(COUNTED, event.type);
}
