import { act, renderHook } from "@testing-library/react";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { sockets } from "../testing/fake-socket.ts";
import { BACKOFF, useEventStream } from "./use-event-stream.ts";

// These values must exist before the hook module chooses its production default fetcher.
vi.hoisted(() => {
  vi.stubEnv("NEXT_PUBLIC_API_URL", "https://app.example.com/backend");
  vi.stubEnv("NEXT_PUBLIC_API_WS_URL", "wss://nap-api.onrender.com");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

it("fetches fresh credentials through the first-party proxy before each direct socket", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ ticket: "first-signed-ticket" }))
    .mockResolvedValueOnce(Response.json({ ticket: "second-signed-ticket" }));
  vi.stubGlobal("fetch", fetch);
  const net = sockets();
  const sessionId = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
  const { unmount } = renderHook(() =>
    useEventStream({ sessionId, createSocket: net.createSocket }),
  );
  await act(async () => {});

  expect(fetch).toHaveBeenNthCalledWith(
    1,
    `https://app.example.com/backend/sessions/${sessionId}/stream-ticket`,
    { method: "POST", cache: "no-store", credentials: "include" },
  );
  expect(net.opened).toHaveLength(1);
  const first = new URL(net.latest.url);
  expect(first.origin).toBe("wss://nap-api.onrender.com");
  expect(first.pathname).toBe("/ws");
  expect(first.searchParams.get("sessionId")).toBe(sessionId);
  expect(first.searchParams.get("ticket")).toBe("first-signed-ticket");

  act(() => net.latest.drop());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(BACKOFF.initialMs);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(net.opened).toHaveLength(2);
  expect(new URL(net.latest.url).searchParams.get("ticket")).toBe("second-signed-ticket");
  unmount();
  expect(net.latest.closed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
