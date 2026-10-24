import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { FAKE_OWNER } from "@nap/db/testing/in-memory-project-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { createLogger } from "../logger.ts";

const sessionId = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const turnId = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";
async function fixture(
  userId: string | null = FAKE_OWNER,
  key = `computer/project/${sessionId}/${turnId}/screen.jpg`,
) {
  const events = new InMemoryEventStore();
  const objects = new InMemoryObjectStore();
  await objects.put(key, new Uint8Array([255, 216, 255, 217]));
  await events.append({
    type: "computer.screenshot",
    sessionId,
    turnId,
    createdAt: "2026-10-24T00:00:00Z",
    payload: { toolCallId: "screen", key, width: 1024, height: 768 },
  });
  const app = createApp({
    logger: createLogger({ level: "silent" }, { write: () => {} }),
    authenticate: async () => (userId ? { userId, isAnonymous: false } : null),
    stream: {
      store: events,
      bus: new InMemoryEventBus(),
      upgradeWebSocket: async () => new Response(),
    },
    computerScreenshots: {
      events,
      objects,
      sessions: new InMemorySessionStore([{ sessionId, projectId: "project", userId: FAKE_OWNER }]),
    },
  });
  return { app, objects };
}
const path = `/sessions/${sessionId}/computer/screenshots/1`;
it("serves only the owner's JPEG with private non-cacheable headers", async () => {
  const { app } = await fixture();
  const response = await app.request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    new Uint8Array([255, 216, 255, 217]),
  );
});
it.each([
  [null, 401],
  ["someone-else", 404],
] as const)("denies %s without asking object storage", async (user, status) => {
  const { app, objects } = await fixture(user);
  const get = vi.spyOn(objects, "get");
  expect((await app.request(path)).status).toBe(status);
  expect(get).not.toHaveBeenCalled();
});
it("rejects a stored key outside the owned project's call identity", async () => {
  const { app, objects } = await fixture(FAKE_OWNER, "computer/someone-else/private.jpg");
  const get = vi.spyOn(objects, "get");
  expect((await app.request(path)).status).toBe(404);
  expect(get).not.toHaveBeenCalled();
});
it("keeps missing and unavailable storage distinct", async () => {
  const { app, objects } = await fixture();
  vi.spyOn(objects, "get")
    .mockResolvedValueOnce({ ok: false, error: { code: "not_found", message: "gone" } })
    .mockResolvedValueOnce({ ok: false, error: { code: "unavailable", message: "offline" } });
  expect((await app.request(path)).status).toBe(404);
  expect((await app.request(path)).status).toBe(503);
  expect((await app.request(path.replace(/1$/, "0"))).status).toBe(400);
  expect((await app.request(path.replace(/1$/, "999"))).status).toBe(404);
});
