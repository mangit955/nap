/**
 * Asserting where a new sandbox's `preview.ready` landed, without pinning it to one position.
 *
 * The announcement is written whenever the dev server answers, so its position among a turn's
 * events is the dev server's timing rather than a contract — an instant fake puts it after
 * `turn.started` today, and any extra `await` before the agent would move it. What *is* the
 * contract is that it comes after the prompt and before the first ending emitted after it was
 * started (`SingleAgentRuntime#startPreviewAnnouncement`). This checks exactly that and hands
 * back the rest of the log, so a test can go on asserting the exact order of everything else.
 */

import type { NapEventType } from "@nap/shared/events";

const ENDINGS: readonly NapEventType[] = ["turn.completed", "turn.failed", "job.completed"];

function typeOf(event: NapEventType | { type: NapEventType }): NapEventType {
  return typeof event === "string" ? event : event.type;
}

/** Takes events, or just their types, and returns the same kind with the announcement removed. */
export function withoutAnnouncement<T extends NapEventType | { type: NapEventType }>(
  events: readonly T[],
): T[] {
  const types = events.map(typeOf);
  const at = types.indexOf("preview.ready");
  if (at === -1 || types.lastIndexOf("preview.ready") !== at)
    throw new Error(`expected exactly one preview.ready in: ${types.join(" → ")}`);

  const prompt = types.indexOf("user.message");
  const ending = types.findIndex((type) => ENDINGS.includes(type));
  if (at < prompt || (ending !== -1 && at > ending))
    throw new Error(
      `preview.ready must follow the prompt and precede the turn's ending: ${types.join(" → ")}`,
    );

  return events.filter((_, index) => index !== at);
}
