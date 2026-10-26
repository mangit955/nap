import { computerRecordingKey } from "@nap/shared/computer-artifacts";
import type { EventStore } from "@nap/shared/ports/event-store";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { SessionStore } from "@nap/shared/ports/session-store";
import type { Hono } from "hono";
import { z } from "zod";
import { findOwnedSession } from "../auth/owned-session.ts";
import type { AuthVariables } from "../auth/require-user.ts";

export type TestRecordingDeps = {
  sessions: SessionStore;
  events: EventStore;
  objects: ObjectStore;
};
const DownloadSchema = z.strictObject({ download: z.literal("1").optional() });
function byteRange(header: string, length: number): { start: number; end: number } | null {
  if (header.length > 80) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0 && length > 0
      ? { start: Math.max(0, length - suffix), end: length - 1 }
      : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : length - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < length && end >= start
    ? { start, end: Math.min(end, length - 1) }
    : null;
}

export function registerTestRecordingRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  deps: TestRecordingDeps,
): void {
  app.on(["GET", "HEAD"], "/sessions/:sessionId/tests/:turnId/recording", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const owned = await findOwnedSession(deps.sessions, c.req.param("sessionId"), c.get("userId"));
    if (!owned.ok) return c.json({ error: owned.error.message }, owned.error.status);
    const turnId = z.uuid().safeParse(c.req.param("turnId"));
    const query = DownloadSchema.safeParse(c.req.query());
    if (!turnId.success || !query.success)
      return c.json({ error: "Invalid recording request." }, 400);
    const events = (await deps.events.readFrom(owned.value.sessionId, 0)).filter(
      (event) => event.turnId === turnId.data,
    );
    const started = events.find((event) => event.type === "test.started");
    const last = events.findLast((event) => event.type === "test.recording");
    if (
      !started ||
      last?.type !== "test.recording" ||
      last.payload.recording.state !== "available" ||
      started.seq >= last.seq
    )
      return c.json({ error: "No such recording." }, 404);
    const key = computerRecordingKey({
      projectId: owned.value.projectId,
      sessionId: owned.value.sessionId,
      turnId: turnId.data,
    });
    if (last.payload.recording.key !== key) return c.json({ error: "No such recording." }, 404);
    const result = await deps.objects.get(key);
    if (!result.ok)
      return c.json(
        { error: "Recording is unavailable." },
        result.error.code === "not_found" ? 404 : 503,
      );
    const bytes = result.value;
    const headers = {
      "Content-Type": "video/mp4",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Content-Disposition": `${query.data.download ? "attachment" : "inline"}; filename="nap-test-recording.mp4"`,
    };
    const requested = c.req.header("range");
    const range = requested === undefined ? undefined : byteRange(requested, bytes.byteLength);
    if (range === null)
      return c.body(null, 416, { ...headers, "Content-Range": `bytes */${bytes.byteLength}` });
    const body = range ? bytes.slice(range.start, range.end + 1) : Uint8Array.from(bytes);
    const responseHeaders = {
      ...headers,
      "Content-Length": String(body.byteLength),
      ...(range
        ? { "Content-Range": `bytes ${range.start}-${range.end}/${bytes.byteLength}` }
        : {}),
    };
    if (c.req.method === "HEAD") return c.body(null, range ? 206 : 200, responseHeaders);
    return c.body(body.buffer, range ? 206 : 200, responseHeaders);
  });
}
