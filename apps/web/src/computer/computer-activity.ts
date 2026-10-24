import type { StoredEvent } from "@nap/shared/ports/event-store";
import type { TurnActivity } from "../chat/use-turn-submission.ts";
import { inFlightTurn } from "../chat/working-state.ts";
import { foldAppTests } from "./app-test-state.ts";

/** Share chat's idle boundary while keeping capture finalization busy after the agent stops. */
export function computerIsBusy({
  sessionId,
  events,
  activity,
}: {
  sessionId: string | undefined;
  events: readonly StoredEvent[];
  activity: TurnActivity | null;
}): boolean {
  const observed = activity && activity.sessionId === sessionId ? activity : null;
  const history = events.filter((event) => event.sessionId === sessionId);
  const idleThroughSeq = observed?.idleThroughSeq ?? 0;
  if (observed?.running || inFlightTurn(history, idleThroughSeq)) return true;
  const pending = new Set(
    foldAppTests(history)
      .filter((test) => test.status === "running")
      .map((test) => test.turnId),
  );
  return history.some(
    (event) =>
      event.type === "test.started" && event.seq > idleThroughSeq && pending.has(event.turnId),
  );
}
