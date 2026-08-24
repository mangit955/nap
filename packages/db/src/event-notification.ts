/**
 * What travels down the wake-up channel: a session and a sequence number, and nothing else.
 *
 * **Never the event.** Postgres caps a `NOTIFY` payload at 8000 bytes, and Nap's events carry
 * command output, file contents and model prose — so a payload-carrying design would work in
 * every test anyone thought to write and then fail on precisely the largest events, which are
 * the ones somebody is watching. A notification is a wake-up signal; the durable log is the
 * delivery. See `docs/scaling-design.md` §8.
 *
 * Parsed rather than cast on the way in, like every other boundary here. The channel is shared
 * by every process on the database, so a malformed payload is a thing that can actually happen —
 * an older or newer replica mid-rollout — and it must cost one ignored wake-up rather than the
 * listener.
 */

import { z } from "zod";

export const EventNotificationSchema = z.object({
  sessionId: z.uuid(),
  seq: z.int().positive(),
});

export type EventNotification = z.infer<typeof EventNotificationSchema>;

/** The channel names. Two, so the events channel carries `{sessionId, seq}` and nothing else. */
export const EVENT_CHANNEL = "nap_events";

/**
 * Where a process shouts to hear its own echo.
 *
 * A `LISTEN` connection that has quietly died looks exactly like a session where nothing is
 * happening, and that is the failure `/readyz` has to be able to see. Nothing else proves the
 * whole path — a socket can be open while the backend has stopped delivering — so the process
 * announces itself here on every poll tick and watches for its own announcement coming back.
 */
export const HEARTBEAT_CHANNEL = "nap_events_heartbeat";

export const HeartbeatSchema = z.object({ instanceId: z.string().min(1) });

export function encodeNotification(notification: EventNotification): string {
  return JSON.stringify(notification);
}

/** `null` for anything that is not a notification this version understands. */
export function decodeNotification(payload: string): EventNotification | null {
  try {
    const parsed = EventNotificationSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function decodeHeartbeat(payload: string): string | null {
  try {
    const parsed = HeartbeatSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data.instanceId : null;
  } catch {
    return null;
  }
}
