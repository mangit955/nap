import type { NapEvent, NapEventType } from "@nap/shared/events";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFileContent, useProjectFiles } from "./use-project-files.ts";

/**
 * `.test.tsx` even with barely any JSX in it: `renderHook` needs a DOM, and the filename is
 * what routes a test to the jsdom project. Every request goes through an injected fetch, so
 * nothing here touches the network.
 */

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

let nextSeq = 1;

function ev<T extends NapEventType>(type: T, payload: Extract<NapEvent, { type: T }>["payload"]) {
  return {
    type,
    sessionId: SESSION,
    turnId: TURN,
    seq: nextSeq++,
    createdAt: "2026-08-09T12:00:00.000Z",
    payload,
  } as StoredEvent;
}

const fileChanged = (path: string) =>
  ev("file.changed", { path: `${PROJECT_ROOT_PATH}/${path}`, changeType: "modified", diff: "" });

/** Records every URL asked for and answers with whatever the test set up. */
function fetcher(answers: Record<string, unknown>, calls: string[] = []) {
  const fetchJson = async (url: string): Promise<Response> => {
    calls.push(url);
    const path = new URL(url).pathname + new URL(url).search;
    const body = answers[path] ?? answers[url];
    if (body === undefined) return new Response(JSON.stringify({ error: "nope" }), { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetchJson, calls };
}

const LISTING = { ready: true, files: ["index.html", "src/App.tsx"], truncated: false };

describe("useProjectFiles", () => {
  it("loads the session's files", async () => {
    const { fetchJson } = fetcher({ [`/sessions/${SESSION}/files`]: LISTING });

    const { result } = renderHook(() =>
      useProjectFiles({ sessionId: SESSION, events: [], fetchJson }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.listing).toEqual(LISTING);
  });

  it("asks for nothing at all without a session", async () => {
    // What the shell renders before a session exists. A request to `/sessions/undefined/files`
    // is a 400 the user would see as a broken pane.
    const { fetchJson, calls } = fetcher({});

    const { result } = renderHook(() =>
      useProjectFiles({ sessionId: undefined, events: [], fetchJson }),
    );

    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(calls).toEqual([]);
  });

  it("asks again when a file changes", async () => {
    const { fetchJson, calls } = fetcher({ [`/sessions/${SESSION}/files`]: LISTING });

    const { rerender } = renderHook(
      (events: StoredEvent[]) => useProjectFiles({ sessionId: SESSION, events, fetchJson }),
      { initialProps: [] as StoredEvent[] },
    );

    await waitFor(() => expect(calls).toHaveLength(1));
    rerender([fileChanged("src/App.tsx")]);

    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it("does not ask again when an ordinary event arrives", async () => {
    // The transcript produces events continuously during a turn. Refetching the whole project
    // on each one would put a request behind every token the model streams.
    const { fetchJson, calls } = fetcher({ [`/sessions/${SESSION}/files`]: LISTING });

    const { rerender } = renderHook(
      (events: StoredEvent[]) => useProjectFiles({ sessionId: SESSION, events, fetchJson }),
      { initialProps: [] as StoredEvent[] },
    );

    await waitFor(() => expect(calls).toHaveLength(1));
    rerender([ev("agent.message", { text: "still working" })]);

    // Given a moment to make the request it must not make.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1);
  });

  it("asks again when a turn completes", async () => {
    // A turn that ran `bun add` changed files without a single file.changed event.
    const { fetchJson, calls } = fetcher({ [`/sessions/${SESSION}/files`]: LISTING });

    const { rerender } = renderHook(
      (events: StoredEvent[]) => useProjectFiles({ sessionId: SESSION, events, fetchJson }),
      { initialProps: [] as StoredEvent[] },
    );

    await waitFor(() => expect(calls).toHaveLength(1));
    rerender([
      ev("turn.completed", {
        usage: { inputTokens: 1, outputTokens: 1 },
        durationMs: 10,
        commitSha: null,
      }),
    ]);

    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it("reports a failure instead of an empty project", async () => {
    // An empty list and a broken request look identical in a tree; only one of them means
    // "the agent has not written anything yet".
    const { fetchJson } = fetcher({});

    const { result } = renderHook(() =>
      useProjectFiles({ sessionId: SESSION, events: [], fetchJson }),
    );

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.listing).toBeUndefined();
  });

  it("refuses a listing that does not match the contract", async () => {
    const { fetchJson } = fetcher({ [`/sessions/${SESSION}/files`]: { files: "everything" } });

    const { result } = renderHook(() =>
      useProjectFiles({ sessionId: SESSION, events: [], fetchJson }),
    );

    await waitFor(() => expect(result.current.status).toBe("error"));
  });
});

describe("useFileContent", () => {
  const CONTENT = {
    path: "src/App.tsx",
    contents: "export default function App() {}\n",
    truncated: false,
    bytes: 33,
  };

  it("loads the selected file", async () => {
    const { fetchJson } = fetcher({
      [`/sessions/${SESSION}/file?path=src%2FApp.tsx`]: CONTENT,
    });

    const { result } = renderHook(() =>
      useFileContent({ sessionId: SESSION, path: "src/App.tsx", fetchJson }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.file).toEqual(CONTENT);
  });

  it("fetches nothing while no file is selected", async () => {
    const { fetchJson, calls } = fetcher({});

    const { result } = renderHook(() =>
      useFileContent({ sessionId: SESSION, path: undefined, fetchJson }),
    );

    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(calls).toEqual([]);
  });

  it("reports a file it could not read", async () => {
    const { fetchJson } = fetcher({});

    const { result } = renderHook(() =>
      useFileContent({ sessionId: SESSION, path: "src/Gone.tsx", fetchJson }),
    );

    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("ignores an answer that arrived after the selection moved on", async () => {
    // Clicking two files quickly is ordinary, and the network does not promise to answer in
    // order. Showing the first file's contents under the second file's name is the bug this
    // prevents.
    const slow = new Map<string, () => void>();
    const fetchJson = async (url: string): Promise<Response> => {
      const body = url.includes("First") ? { ...CONTENT, path: "src/First.tsx" } : CONTENT;
      await new Promise<void>((resolve) => slow.set(url, resolve));
      return new Response(JSON.stringify(body), { status: 200 });
    };

    const { result, rerender } = renderHook(
      (path: string) => useFileContent({ sessionId: SESSION, path, fetchJson }),
      { initialProps: "src/First.tsx" },
    );

    await waitFor(() => expect(slow.size).toBe(1));
    rerender("src/App.tsx");
    await waitFor(() => expect(slow.size).toBe(2));

    // The second selection answers first, and the abandoned one answers after it.
    slow.get([...slow.keys()][1] ?? "")?.();
    await waitFor(() => expect(result.current.file?.path).toBe("src/App.tsx"));

    slow.get([...slow.keys()][0] ?? "")?.();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(result.current.file?.path).toBe("src/App.tsx");
  });
});
