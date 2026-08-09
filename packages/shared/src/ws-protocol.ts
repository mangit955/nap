/**
 * What travels over the event-stream WebSocket, in both directions.
 *
 * The server and the browser client are written in different tasks and deploy separately, so
 * the frames are a contract rather than an understanding — defined once here and validated at
 * both ends, the way `events.ts` defines what a turn produces.
 *
 * Events are sent one frame at a time rather than batched, including during replay. The
 * client then has a single code path for "an event arrived" and dedupes on `seq` alone,
 * which is what makes reconnecting mid-turn indistinguishable from connecting fresh.
 *
 * The heartbeat is an ordinary `ping` frame, not a WebSocket control frame. Browser
 * JavaScript can neither send a control-frame pong nor observe a ping, so a control-frame
 * heartbeat would be invisible to the only client this protocol has.
 */

import { z } from "zod";
import { NapEventSchema } from "./events.ts";
import type { Result } from "./result.ts";

/** Server → client. */
export const ServerFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("event"), event: NapEventSchema }),
  z.strictObject({ type: z.literal("ping") }),
  /**
   * Something the client sent could not be understood. Advisory: the connection stays open,
   * because a client bug should not cost someone their transcript.
   */
  z.strictObject({ type: z.literal("error"), message: z.string().min(1) }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

/**
 * Client → server. A union with one member today: the client is a reader, and the only thing
 * it has to say is that it is still there. Anything it might say later is additive.
 */
export const ClientFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("pong") }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

/**
 * Close codes. 1000–2999 belong to the WebSocket specification and its extensions; 4000–4999
 * are reserved for applications, and a client that reconnects needs to tell "you were idle"
 * from "that session does not exist" without parsing prose.
 */
export const WS_CLOSE = {
  /** No frame arrived from the client within the heartbeat timeout. */
  heartbeatTimeout: 4000,
} as const;

/** Parsing a frame the client sent is a boundary, so failure is a value, not an exception. */
export function parseClientFrame(raw: unknown): Result<ClientFrame, { message: string }> {
  if (typeof raw !== "string") {
    return { ok: false, error: { message: "frames must be text, not binary" } };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: { message: "frame is not valid JSON" } };
  }

  const parsed = ClientFrameSchema.safeParse(json);
  if (!parsed.success) {
    // The issue path, not the whole Zod report: the client needs to know which field it got
    // wrong, and the full report is several hundred bytes of nesting.
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? "frame" : issue.path.join(".");
    return { ok: false, error: { message: `${where}: ${issue?.message ?? "unrecognised frame"}` } };
  }

  return { ok: true, value: parsed.data };
}
