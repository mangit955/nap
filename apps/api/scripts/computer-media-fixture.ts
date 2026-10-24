/** Free local media smoke: the real playback route over fake identity/storage and a real MP4. */
import { readFile } from "node:fs/promises";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { computerRecordingKey } from "@nap/shared/computer-artifacts";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AuthVariables } from "../src/auth/require-user.ts";
import { registerTestRecordingRoutes } from "../src/computer/recordings.ts";

const sessionId = "00000000-0000-4000-8000-000000000001";
const turnId = "00000000-0000-4000-8000-000000000002";
const projectId = "fixture-project";
const events = new InMemoryEventStore();
const objects = new InMemoryObjectStore();
const sessions = new InMemorySessionStore([{ sessionId, projectId, userId: "fixture-owner" }]);
const key = computerRecordingKey({ projectId, sessionId, turnId });
const stored = await objects.put(
  key,
  new Uint8Array(
    await readFile(
      new URL("../../../docs/research/computer-recording-linux/capture.mp4", import.meta.url),
    ),
  ),
);
if (!stored.ok) throw new Error("Local clip could not be seeded.");
const envelope = { sessionId, turnId, createdAt: "2026-10-24T00:00:00Z" };
await events.append({
  ...envelope,
  type: "test.started",
  payload: { jobId: turnId, objective: "Local capture", commitSha: "abcdef1" },
});
await events.append({
  ...envelope,
  type: "test.recording",
  payload: {
    recording: {
      state: "available",
      key,
      durationMs: 1000,
      width: 1024,
      height: 768,
      interrupted: false,
    },
  },
});
const app = new Hono<{ Variables: AuthVariables }>();
app.use("*", cors({ origin: "http://localhost:3037", credentials: true }));
app.use("*", async (context, next) => {
  context.set("userId", "fixture-owner");
  await next();
});
registerTestRecordingRoutes(app, { sessions, events, objects });
Bun.serve({ hostname: "127.0.0.1", port: 43180, fetch: app.fetch });
console.log(
  "Local media fixture :43180; fake identity/storage, actual owner recording route and MP4.",
);
