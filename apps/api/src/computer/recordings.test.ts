import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { FAKE_OWNER } from "@nap/db/testing/in-memory-project-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { computerRecordingKey } from "@nap/shared/computer-artifacts";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { createLogger } from "../logger.ts";

const sessionId = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const turnId = "72a3e710-65bf-420e-8cea-d4aa8e0b2f7d";
const video = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));
const path = `/sessions/${sessionId}/tests/${turnId}/recording`;
async function fixture(
  options: { user?: string | null; key?: string; started?: boolean; available?: boolean } = {},
) {
  const events = new InMemoryEventStore();
  const objects = new InMemoryObjectStore();
  const base = { sessionId, turnId, createdAt: "2026-10-24T00:00:00Z" };
  const key = options.key ?? computerRecordingKey({ projectId: "project", sessionId, turnId });
  await objects.put(key, video);
  if (options.started !== false)
    await events.append({
      ...base,
      type: "test.started",
      payload: { jobId: turnId, commitSha: "abc", objective: "Save a note" },
    });
  if (options.available !== false)
    await events.append({
      ...base,
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
  const user = options.user === undefined ? FAKE_OWNER : options.user;
  const app = createApp({
    logger: createLogger({ level: "silent" }, { write: () => {} }),
    authenticate: async () => (user ? { userId: user, isAnonymous: false } : null),
    stream: {
      store: events,
      bus: new InMemoryEventBus(),
      upgradeWebSocket: async () => new Response(),
    },
    testRecordings: {
      events,
      objects,
      sessions: new InMemorySessionStore([{ sessionId, projectId: "project", userId: FAKE_OWNER }]),
    },
  });
  return { app, events, objects, base };
}
it("serves owner video with private headers and a separate download response", async () => {
  const { app } = await fixture();
  const response = await app.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("video/mp4");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("accept-ranges")).toBe("bytes");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(video);
  const download = await app.request(`${path}?download=1`);
  expect(download.headers.get("content-disposition")).toBe(
    'attachment; filename="nap-test-recording.mp4"',
  );
  const head = await app.request(path, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe("32");
  expect((await head.arrayBuffer()).byteLength).toBe(0);
});
it.each([
  [null, 401],
  ["other-owner", 404],
] as const)("denies %s before reading events or storage", async (user, status) => {
  const f = await fixture({ user });
  const read = vi.spyOn(f.events, "readFrom");
  const get = vi.spyOn(f.objects, "get");
  expect((await f.app.request(path)).status).toBe(status);
  expect(read).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});
it.each([{ key: "computer/other-owner/private.mp4" }, { started: false }, { available: false }])(
  "does not serve an unindexed, unannounced or foreign clip %j",
  async (options) => {
    const f = await fixture(options);
    const get = vi.spyOn(f.objects, "get");
    expect((await f.app.request(path)).status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  },
);
it.each([
  ["bytes=0-3", 0, 3],
  ["bytes=28-", 28, 31],
  ["bytes=-4", 28, 31],
  ["bytes=29-100", 29, 31],
] as const)("supports seeking range %s", async (range, start, end) => {
  const { app } = await fixture();
  const response = await app.request(path, { headers: { range } });
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/32`);
  expect(response.headers.get("content-length")).toBe(String(end - start + 1));
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(video.slice(start, end + 1));
});
it.each([
  "bytes=32-",
  "bytes=32-40",
  "bytes=0-9007199254740992",
  "bytes=-9007199254740992",
  "bytes=9-2",
  "bytes=-0",
  "bytes=-",
  "bytes=0-1,3-4",
  "bytes=9007199254740992-",
])("rejects unsupported range %s", async (range) => {
  const { app } = await fixture();
  const response = await app.request(path, { headers: { range } });
  expect(response.status).toBe(416);
  expect(response.headers.get("content-range")).toBe("bytes */32");
});
it("distinguishes missing storage from a transient outage", async () => {
  const f = await fixture();
  vi.spyOn(f.objects, "get")
    .mockResolvedValueOnce({ ok: false, error: { code: "not_found", message: "missing" } })
    .mockResolvedValueOnce({ ok: false, error: { code: "unavailable", message: "private error" } });
  expect((await f.app.request(path)).status).toBe(404);
  const response = await f.app.request(path);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private error");
});
it("refuses a later unavailable state and malformed request identities", async () => {
  const f = await fixture();
  await f.events.append({
    ...f.base,
    type: "test.recording",
    payload: { recording: { state: "unavailable", reason: "timing_failed" } },
  });
  expect((await f.app.request(path)).status).toBe(404);
  expect((await f.app.request(path.replace(turnId, "invalid"))).status).toBe(400);
  expect((await f.app.request(`${path}?download=invalid`)).status).toBe(400);
});
