/**
 * Closing out the turns whose worker never came back.
 *
 * A worker that dies mid-turn leaves a request `leased` and a Turn with no terminal event.
 * `openEventStream` has no timeout, so the chat pane waits on an event nobody will ever write —
 * it spins forever and the person watching it is told nothing at all. This is what writes that
 * event: past the grace window the request becomes `orphaned` and, under the request's own turn
 * id, a `turn.failed` and a `system.notice` go into the log. **A `resume` gets the notice alone**
 * — opening a project starts no turn, so there is nothing waiting and nothing to fail.
 *
 * **It does not requeue, and that is the point.** Automatic re-execution is the autonomous loop
 * that spends tokens with nobody watching, which `CONTEXT.md`'s *Continue* semantics forbid. The
 * Job is left open; a human reopening the project is the signal that somebody is there to watch,
 * and `continuationFor` decides what happens then.
 *
 * **The grace window is a fence, not a timeout.** Renewal is conditional, so a worker that lost
 * its lease has aborted by expiry plus one renewal interval; reclaiming only at expiry plus the
 * grace is the sole reason two writers on one session are unreachable. The margin lives in
 * `@nap/shared/lease-windows` and the queue applies it — nothing here may shorten it.
 *
 * **Orphaning and announcing are two steps, because they are two systems.** One is a row in
 * Postgres and the other is an append plus a fanout, and no transaction spans them. So the row is
 * taken first and marked announced only once its events are durable: a janitor that dies in
 * between leaves an orphan the next tick finds and finishes, rather than a request that is
 * terminal in the queue and still spinning in somebody's chat pane. Taking the row first is what
 * makes it exclusive; announcing second is what makes the invariant recoverable.
 *
 * Nothing here throws and nothing stops early on one failure, for the reason the sweep it runs
 * beside does not: every request it did not get to is another pane waiting on an event.
 */

import { getLogger } from "@nap/shared/logging";
import type { EventBus } from "@nap/shared/ports/event-bus";
import type { EventStore } from "@nap/shared/ports/event-store";
import type { OrphanedTurnRequest, TurnQueue } from "@nap/shared/ports/turn-queue";
import { EventSink } from "./event-sink.ts";

/**
 * What the chat pane is told, in the two registers a person needs.
 *
 * `internal` rather than `cancelled`: nobody asked for this to stop. And the notice says where
 * the work went, because the honest answer — it is all still there and reopening picks it up —
 * is not one anybody would guess from a failed turn.
 */
const INTERRUPTED_MESSAGE =
  "This turn was interrupted: the worker running it stopped responding, so it never finished.";
const RESUME_NOTICE =
  "Nothing was lost — the work so far is saved. Reopen the project to pick it up from where it stopped.";

export type JanitorFailure = {
  /** Which request could not be closed out, or null when the queue itself could not be asked. */
  requestId: string | null;
  message: string;
};

export type JanitorResult = {
  /** Requests taken out of `leased` on this tick, oldest expiry first. */
  orphaned: string[];
  /** Requests whose terminal events are now durably in the log — this tick's and any owed. */
  announced: string[];
  failed: JanitorFailure[];
};

export type JanitorOptions = {
  queue: TurnQueue;
  events: EventStore;
  bus: EventBus;
  /** How many requests one tick will close out. The queue's own default when absent. */
  limit?: number;
  /** Injected so a test can place a timestamp exactly rather than read the wall clock. */
  now?: () => string;
};

export async function sweepOrphanedRequests(options: JanitorOptions): Promise<JanitorResult> {
  const logger = getLogger();
  const result: JanitorResult = { orphaned: [], announced: [], failed: [] };

  try {
    const taken = await options.queue.orphanExpired(options.limit);
    result.orphaned = taken.map((request) => request.id);
  } catch (error) {
    // Not a return: whatever was orphaned on an earlier tick is still owed its events, and that
    // is the half a person is actually waiting on.
    result.failed.push({ requestId: null, message: messageOf(error) });
    logger.error({ err: error }, "could not reclaim expired leases");
  }

  let owed: readonly OrphanedTurnRequest[];
  try {
    owed = await options.queue.unannouncedOrphans(options.limit);
  } catch (error) {
    result.failed.push({ requestId: null, message: messageOf(error) });
    logger.error({ err: error }, "could not read the orphans owed a terminal event");
    return result;
  }

  for (const request of owed) {
    const announced = await announce(request, options);
    if (announced === null) result.announced.push(request.id);
    else result.failed.push({ requestId: request.id, message: announced });
  }

  return result;
}

/** Writes one orphan's terminal events and records that it did. The message, on failure. */
async function announce(
  request: OrphanedTurnRequest,
  options: JanitorOptions,
): Promise<string | null> {
  const createdAt = (options.now ?? (() => new Date().toISOString()))();
  const sink = new EventSink(options.events, options.bus);

  // Both under the request's own id, which is the first Turn's turn id. That identity is what
  // lets something which never ran the turn close the right one — see `docs/scaling-design.md`
  // §6. Ordered: the terminal event ends the turn, and the notice explains it.
  //
  // **A resume gets the notice alone.** Nobody started a turn by opening a project, so a
  // `turn.failed` there is a failure in the transcript for something the user never asked for,
  // offered back to them with a retry of an unrelated message. The event exists to stop a pane
  // spinning on a turn it is waiting for, and an open leaves nothing waiting: there is no
  // `user.message` to be unanswered.
  if (request.kind === "turn") {
    sink.emit({
      type: "turn.failed",
      payload: { reason: "internal", message: INTERRUPTED_MESSAGE },
      sessionId: request.sessionId,
      turnId: request.id,
      createdAt,
    });
  }
  sink.emit({
    type: "system.notice",
    payload: { level: "warning", text: RESUME_NOTICE },
    sessionId: request.sessionId,
    turnId: request.id,
    createdAt,
  });

  try {
    await sink.drain();
  } catch (error) {
    // The row stays unannounced, so the next tick tries again. Retrying is right even though a
    // duplicate is conceivable: a second terminal event in a chat pane is untidy, and no
    // terminal event at all is a pane that never stops spinning.
    return messageOf(error);
  }

  try {
    await options.queue.markOrphanAnnounced(request.id);
  } catch (error) {
    return messageOf(error);
  }

  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
