/**
 * Building stored events for a test, without re-deriving the envelope in every file.
 *
 * A stored event is a payload wrapped in five fields nobody's assertion is about — session, turn,
 * sequence, timestamp, type — and eleven test files had each written their own `ev` to supply
 * them. They agreed by coincidence rather than by construction, which is exactly the kind of
 * agreement that stops holding the day the envelope gains a field.
 *
 * The ids are fixed and exported: a test that pushes an event into a stream opened for
 * `SESSION_ID` needs the two to match, since `useEventStream` drops anything belonging to another
 * session.
 */

import type { NapEvent, NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";

export const SESSION_ID = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
export const OTHER_SESSION_ID = "1c8f9f2e-4d3b-4e6c-8f7a-2b3c4d5e6f70";
export const TURN_ID = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
export const PROJECT_ID = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";

/**
 * One stored event. `seq` is explicit because ordering is the subject of most of these tests, and
 * a counter hidden in here would make two events written side by side depend on how many were
 * built before them.
 */
export function ev<T extends NapEventType>(
  type: T,
  payload: Extract<NapEvent, { type: T }>["payload"],
  seq: number,
  over: { sessionId?: string; turnId?: string; createdAt?: string } = {},
): StoredEvent {
  return {
    type,
    sessionId: over.sessionId ?? SESSION_ID,
    turnId: over.turnId ?? TURN_ID,
    seq,
    createdAt: over.createdAt ?? "2026-08-09T12:00:00.000Z",
    payload,
  } as StoredEvent;
}
