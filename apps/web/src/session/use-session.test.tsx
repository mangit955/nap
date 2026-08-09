import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SESSION_STORAGE_KEY, useSession } from "./use-session.ts";

/**
 * `.test.tsx` because `renderHook` needs a DOM, and jsdom is also where `localStorage` lives.
 */

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";

function creator(response: unknown = { sessionId: SESSION, projectId: PROJECT }, status = 201) {
  const calls: string[] = [];
  const fetchJson = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    return new Response(JSON.stringify(response), { status });
  };

  return { fetchJson, calls };
}

beforeEach(() => {
  localStorage.clear();
});

describe("useSession", () => {
  it("creates a session when the browser has never had one", async () => {
    const { fetchJson, calls } = creator();

    const { result } = renderHook(() => useSession({ fetchJson }));

    await waitFor(() => expect(result.current.sessionId).toBe(SESSION));
    expect(calls).toEqual(["POST /sessions"]);
  });

  it("remembers it, so a reload continues the same conversation", async () => {
    // Without this every refresh starts an empty project, and the transcript the user was
    // reading is still in the database with nothing pointing at it.
    const first = creator();
    const { result } = renderHook(() => useSession({ fetchJson: first.fetchJson }));
    await waitFor(() => expect(result.current.sessionId).toBe(SESSION));

    const second = creator();
    const reloaded = renderHook(() => useSession({ fetchJson: second.fetchJson }));

    await waitFor(() => expect(reloaded.result.current.sessionId).toBe(SESSION));
    expect(second.calls).toEqual([]);
  });

  it("reads a stored session synchronously, with no request at all", async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, SESSION);
    const { fetchJson, calls } = creator();

    const { result } = renderHook(() => useSession({ fetchJson }));

    expect(result.current.sessionId).toBe(SESSION);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(calls).toEqual([]);
  });

  it("ignores a stored value that is not a session id", async () => {
    // Anything can write to localStorage, and a junk value would otherwise be sent to the API
    // forever, failing every request with a 400 and no way for the user to recover.
    localStorage.setItem(SESSION_STORAGE_KEY, "not-a-uuid");
    const { fetchJson } = creator();

    const { result } = renderHook(() => useSession({ fetchJson }));

    await waitFor(() => expect(result.current.sessionId).toBe(SESSION));
  });

  it("reports a failure instead of hanging on connecting", async () => {
    const { fetchJson } = creator({ error: "no database" }, 500);

    const { result } = renderHook(() => useSession({ fetchJson }));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.sessionId).toBeUndefined();
  });

  it("refuses a response that is not the shape it promised", async () => {
    const { fetchJson } = creator({ sessionId: "nope" });

    const { result } = renderHook(() => useSession({ fetchJson }));

    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("asks only once even though effects run twice under strict mode", async () => {
    // React 19 mounts, unmounts and remounts every effect in development. A create call that
    // is not guarded leaves an orphan project behind on every single page load.
    const { fetchJson, calls } = creator();

    const { rerender } = renderHook(() => useSession({ fetchJson }));
    rerender();
    rerender();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    expect(calls).toEqual(["POST /sessions"]);
  });
});
