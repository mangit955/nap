import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { FetchJson } from "../files/use-project-files.ts";
import { useDesktopStream } from "./use-desktop-stream.ts";

const credentials = {
  url: "wss://desktop.test/websockify",
  password: "owner-secret",
  width: 1024,
  height: 768,
};
it("loads owner credentials only while the live computer is visible and renews on retry", async () => {
  const fetchJson = vi.fn<FetchJson>(async () => Response.json(credentials));
  const view = renderHook(
    ({ active }) => useDesktopStream({ sessionId: "s", sandboxId: "vm", active, fetchJson }),
    { initialProps: { active: false } },
  );
  expect(fetchJson).not.toHaveBeenCalled();
  view.rerender({ active: true });
  await waitFor(() => expect(view.result.current.state.status).toBe("ready"));
  expect(fetchJson).toHaveBeenCalledWith(
    expect.stringContaining("/sessions/s/computer/stream"),
    expect.objectContaining({
      credentials: "include",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    }),
  );
  act(() => view.result.current.retry());
  await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(2));
  view.rerender({ active: false });
  expect(view.result.current.state).toEqual({ status: "idle" });
  expect(fetchJson.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
});

it("discards late credentials from a previous VM or hidden history", async () => {
  let settle: ((response: Response) => void) | undefined;
  const fetchJson = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        settle = resolve;
      }),
  );
  const view = renderHook(
    ({ sandboxId, active }) => useDesktopStream({ sessionId: "s", sandboxId, active, fetchJson }),
    { initialProps: { sandboxId: "old", active: true } },
  );
  const old = settle;
  view.rerender({ sandboxId: "new", active: true });
  await act(async () => old?.(Response.json(credentials)));
  expect(view.result.current.state.status).toBe("loading");
  view.rerender({ sandboxId: "new", active: false });
  await act(async () => settle?.(Response.json(credentials)));
  expect(view.result.current.state).toEqual({ status: "idle" });
});

it.each([
  Response.json({ ...credentials, url: "wss://desktop.test/?password=secret" }),
  Response.json({ ...credentials, width: 1 }),
  new Response("private failure", { status: 503 }),
])("reports a safe failure for invalid or refused stream credentials", async (response) => {
  const fetchJson = async () => response;
  const view = renderHook(() =>
    useDesktopStream({
      sessionId: "s",
      sandboxId: "vm",
      active: true,
      fetchJson,
    }),
  );
  await waitFor(() => expect(view.result.current.state).toEqual({ status: "error" }));
});
