/**
 * Small readings of the log that the chat pane's live parts share: which turn is in flight and
 * when it began, and the one path rewrite every line showing a path makes.
 *
 * Pure, and in a `.ts` beside `transcript.ts` for the same reason that one is: the interesting
 * cases are a log that begins mid-turn and a turn closed twice, and neither needs a DOM to test.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";

/** Paths are absolute in the sandbox; the project root is noise in every single line. */
export function shorten(value: string): string {
  return value.replace("/home/user/app/", "");
}

type InFlightTurn = {
  turnId: string;
  /** Ordinary preparation is busy before the server starts its elapsed clock. */
  startedAt: string | undefined;
};

/**
 * Activity and elapsed time share turn identity. A terminal closes only its own turn and
 * stays closed even if another janitor appends a duplicate start later. Map insertion order
 * keeps a duplicate from displacing newer work; the first clock anchor stays stable too.
 */
export function inFlightTurn(
  events: readonly StoredEvent[],
  idleThroughSeq = 0,
): InFlightTurn | undefined {
  const turns = new Map<string, InFlightTurn | null>();
  for (const event of events) {
    if (event.type === "turn.completed" || event.type === "turn.failed") {
      turns.set(event.turnId, null);
      continue;
    }
    if (
      event.type !== "user.message" &&
      event.type !== "turn.started" &&
      event.type !== "compaction.started"
    )
      continue;

    // Terminals above still apply even when the activity read retired their prefix. That
    // prevents a delayed duplicate start from reopening a turn that already ended.
    if (event.seq <= idleThroughSeq) continue;
    const turn = turns.get(event.turnId);
    if (turn === null) continue;
    const startedAt =
      event.type === "turn.started" ||
      (event.type === "compaction.started" && event.payload.trigger === "manual")
        ? event.createdAt
        : undefined;
    if (turn === undefined) turns.set(event.turnId, { turnId: event.turnId, startedAt });
    else turn.startedAt ??= startedAt;
  }
  return [...turns.values()].findLast((turn) => turn !== null);
}

/** The server's first clock anchor for the active turn, preserved across reloads. */
export function turnStartedAt(events: readonly StoredEvent[]): string | undefined {
  return inFlightTurn(events)?.startedAt;
}
