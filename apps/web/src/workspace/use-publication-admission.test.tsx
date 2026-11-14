import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageVisibility } from "../testing/page-visibility.ts";
import { usePublicationAdmission } from "./use-publication-admission.ts";

/**
 * How a pending publication is watched. Its status is asked for every second until the request
 * ends — and not at all while the tab is hidden, since nobody can see the card it would update.
 */

const PROJECT = "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const SESSION = "4b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const JOB = "5c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
const REQUEST = "6d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a";

function api() {
  const statusReads: (AbortSignal | null | undefined)[] = [];
  const state = { request: "queued" as "queued" | "done" };
  const fetchJson = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    if (path.endsWith("/github/publish"))
      return Response.json({ accepted: true, requestId: REQUEST }, { status: 202 });
    if (path.endsWith(`/turns/${REQUEST}`)) {
      statusReads.push(init?.signal);
      return Response.json({ id: REQUEST, state: state.request });
    }
    throw new Error(`unexpected ${path}`);
  };
  const reload = vi.fn(async () => ({ ok: true as const, applied: true }));
  return { fetchJson, reload, statusReads, state };
}

/** Mounted and published, so the request is accepted and the watch has begun. */
async function published(server: ReturnType<typeof api>) {
  const hook = renderHook(() =>
    usePublicationAdmission({
      baseUrl: "http://api.test",
      projectId: PROJECT,
      sessionId: SESSION,
      userId: "owner",
      jobId: JOB,
      fetchJson: server.fetchJson,
      reload: server.reload,
    }),
  );
  await act(async () => {
    await hook.result.current.publish();
  });
  expect(hook.result.current.queued).toBe(true);
  return hook;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

let page = pageVisibility();

beforeEach(() => {
  vi.useFakeTimers();
  page = pageVisibility();
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  page.restore();
});

describe("watching a pending publication", () => {
  it("asks for the request's status every second while the tab is visible", async () => {
    const server = api();
    const hook = await published(server);
    await advance(3000);
    expect(server.statusReads).toHaveLength(3);
    hook.unmount();
  });

  it("asks nothing from a hidden tab, and asks once, at once, when it is shown", async () => {
    const server = api();
    const hook = await published(server);
    await advance(1000);
    expect(server.statusReads).toHaveLength(1);
    act(() => page.set("hidden"));
    await advance(60_000);
    expect(server.statusReads).toHaveLength(1);
    act(() => page.set("visible"));
    await advance(0);
    expect(server.statusReads).toHaveLength(2);
    hook.unmount();
  });

  it("stops asking, and reloads the job, once the request has ended", async () => {
    const server = api();
    const hook = await published(server);
    server.state.request = "done";
    await advance(1000);
    expect(hook.result.current.pending).toBe(false);
    const reads = server.statusReads.length;
    await advance(10_000);
    expect(server.statusReads).toHaveLength(reads);
    expect(server.reload).toHaveBeenCalled();
    hook.unmount();
  });

  it("leaves no timer behind on unmount", async () => {
    const server = api();
    const hook = await published(server);
    await advance(1000);
    hook.unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
