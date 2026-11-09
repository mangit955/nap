import type { NapEvent, NapEventType } from "@nap/shared/events";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LISTING_DEBOUNCE_MS, useFileContent, useProjectFiles } from "./use-project-files.ts";

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
      useProjectFiles({ sessionId: SESSION, events: [], replayed: true, fetchJson }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.listing).toEqual(LISTING);
  });

  it("asks for nothing at all without a session", async () => {
    // What the shell renders before a session exists. A request to `/sessions/undefined/files`
    // is a 400 the user would see as a broken pane.
    const { fetchJson, calls } = fetcher({});

    const { result } = renderHook(() =>
      useProjectFiles({ sessionId: undefined, events: [], replayed: true, fetchJson }),
    );

    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(calls).toEqual([]);
  });

  it("asks again when a file changes", async () => {
    const { fetchJson, calls } = fetcher({ [`/sessions/${SESSION}/files`]: LISTING });

    const { rerender } = renderHook(
      (events: StoredEvent[]) =>
        useProjectFiles({ sessionId: SESSION, events, replayed: true, fetchJson }),
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
      (events: StoredEvent[]) =>
        useProjectFiles({ sessionId: SESSION, events, replayed: true, fetchJson }),
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
      (events: StoredEvent[]) =>
        useProjectFiles({ sessionId: SESSION, events, replayed: true, fetchJson }),
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

  it("asks again once a sandbox is serving the project", async () => {
    // A new sandbox is a new filesystem, and the moment the listing first becomes possible at
    // all: before it the endpoint answers `ready: false`. Without this the tree sat on that
    // answer until the agent happened to write a file, so a project that had just come up read
    // as one with nothing in it.
    const { fetchJson, calls } = fetcher({ [`/sessions/${SESSION}/files`]: LISTING });

    const { rerender } = renderHook(
      (events: StoredEvent[]) =>
        useProjectFiles({ sessionId: SESSION, events, replayed: true, fetchJson }),
      { initialProps: [] as StoredEvent[] },
    );

    await waitFor(() => expect(calls).toHaveLength(1));
    rerender([ev("preview.ready", { url: "https://5173-abc.e2b.dev", port: 5173 })]);

    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it("reports a failure instead of an empty project", async () => {
    // An empty list and a broken request look identical in a tree; only one of them means
    // "the agent has not written anything yet".
    const { fetchJson } = fetcher({});

    const { result } = renderHook(() =>
      useProjectFiles({ sessionId: SESSION, events: [], replayed: true, fetchJson }),
    );

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.listing).toBeUndefined();
  });

  it("refuses a listing that does not match the contract", async () => {
    const { fetchJson } = fetcher({ [`/sessions/${SESSION}/files`]: { files: "everything" } });

    const { result } = renderHook(() =>
      useProjectFiles({ sessionId: SESSION, events: [], replayed: true, fetchJson }),
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

  it("does not ask twice for a file it has already read", async () => {
    /*
     * The whole reason the cache exists. Every read is a round trip to the *sandbox*, so
     * clicking back and forth between two files was two network round trips each way — which is
     * what "the Code tab does not feel snappy" was.
     */
    const { fetchJson, calls } = fetcher({
      [`/sessions/${SESSION}/file?path=src%2FApp.tsx`]: CONTENT,
      [`/sessions/${SESSION}/file?path=src%2Fmain.tsx`]: { ...CONTENT, path: "src/main.tsx" },
    });

    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useFileContent({ sessionId: SESSION, path, fetchJson }),
      { initialProps: { path: "src/App.tsx" } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ path: "src/main.tsx" });
    await waitFor(() => expect(result.current.file?.path).toBe("src/main.tsx"));

    const before = calls.length;
    rerender({ path: "src/App.tsx" });

    await waitFor(() => expect(result.current.file?.path).toBe("src/App.tsx"));
    expect(calls.length).toBe(before);
  });

  it("shows a cached file without a loading state in between", async () => {
    // A flash of "Loading…" for a file already in memory is exactly the stutter the cache is
    // there to remove, so going back to one must never pass through `loading`.
    const { fetchJson } = fetcher({
      [`/sessions/${SESSION}/file?path=src%2FApp.tsx`]: CONTENT,
      [`/sessions/${SESSION}/file?path=src%2Fmain.tsx`]: { ...CONTENT, path: "src/main.tsx" },
    });

    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useFileContent({ sessionId: SESSION, path, fetchJson }),
      { initialProps: { path: "src/App.tsx" } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ path: "src/main.tsx" });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ path: "src/App.tsx" });

    expect(result.current.status).toBe("ready");
    expect(result.current.file?.path).toBe("src/App.tsx");
  });

  it("reads a file again once the agent has written one", async () => {
    // The other half. A cache that never let go would show yesterday's source for the file the
    // turn just rewrote, which is far worse than a slow read.
    const { fetchJson, calls } = fetcher({
      [`/sessions/${SESSION}/file?path=src%2FApp.tsx`]: CONTENT,
    });

    const { result, rerender } = renderHook(
      ({ events }: { events: StoredEvent[] }) =>
        useFileContent({ sessionId: SESSION, path: "src/App.tsx", events, fetchJson }),
      { initialProps: { events: [] as StoredEvent[] } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const before = calls.length;

    rerender({
      events: [ev("file.changed", { path: "src/App.tsx", changeType: "modified", diff: "+one\n" })],
    });

    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it("does not remember a file it failed to read", async () => {
    // Caching a failure would make one bad read permanent until the next turn.
    const { fetchJson, calls } = fetcher({});

    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useFileContent({ sessionId: SESSION, path, fetchJson }),
      { initialProps: { path: "src/App.tsx" } },
    );
    await waitFor(() => expect(result.current.status).toBe("error"));

    rerender({ path: "src/main.tsx" });
    await waitFor(() => expect(result.current.status).toBe("error"));
    const before = calls.length;

    rerender({ path: "src/App.tsx" });

    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });

  it("makes the first click instant when the file was read ahead", async () => {
    // The whole point of this pass. Caching alone only ever helped the *second* visit to a
    // file; a project's files are read before anybody clicks, so the first is instant too.
    const { fetchJson, calls } = fetcher({
      [`/sessions/${SESSION}/file?path=src%2FApp.tsx`]: CONTENT,
    });

    const { result, rerender } = renderHook(
      ({ path }: { path: string | undefined }) =>
        useFileContent({ sessionId: SESSION, path, fetchJson }),
      { initialProps: { path: undefined as string | undefined } },
    );

    result.current.prefetch(["src/App.tsx"]);
    await waitFor(() => expect(calls.length).toBe(1));

    rerender({ path: "src/App.tsx" });

    // No second request, and no `loading` on the way — it is simply there.
    expect(result.current.status).toBe("ready");
    expect(calls.length).toBe(1);
  });

  it("reads a file once when it is hovered and then clicked", async () => {
    // Hovering a row prefetches it and clicking it selects it. Without an in-flight guard the
    // two fire separate reads for the same file, and hovering would make things slower.
    const { fetchJson, calls } = fetcher({
      [`/sessions/${SESSION}/file?path=src%2FApp.tsx`]: CONTENT,
    });

    const { result, rerender } = renderHook(
      ({ path }: { path: string | undefined }) =>
        useFileContent({ sessionId: SESSION, path, fetchJson }),
      { initialProps: { path: undefined as string | undefined } },
    );

    result.current.prefetch(["src/App.tsx"]);
    rerender({ path: "src/App.tsx" });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(calls.length).toBe(1);
  });

  it("does not re-read something already cached", async () => {
    const { fetchJson, calls } = fetcher({
      [`/sessions/${SESSION}/file?path=src%2FApp.tsx`]: CONTENT,
    });

    const { result } = renderHook(() =>
      useFileContent({ sessionId: SESSION, path: "src/App.tsx", fetchJson }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    result.current.prefetch(["src/App.tsx"]);

    await waitFor(() => expect(calls.length).toBe(1));
  });

  it("keeps at most four reads in the air at once", async () => {
    /*
     * The listing allows up to 500 entries, and every read is a call into the sandbox that the
     * agent may be using at the same time. Unbounded, opening the Code tab on a large project
     * would be a denial of service against the turn running beside it.
     */
    let open = 0;
    let peak = 0;
    const fetchJson = async (): Promise<Response> => {
      open += 1;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open -= 1;
      return new Response(JSON.stringify(CONTENT), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const { result } = renderHook(() =>
      useFileContent({ sessionId: SESSION, path: undefined, fetchJson }),
    );

    result.current.prefetch(Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`));
    await waitFor(() => expect(open).toBe(0), { timeout: 3000 });

    expect(peak).toBeLessThanOrEqual(4);
  });

  it("does not remember a prefetch that failed", async () => {
    // A blip while reading ahead must not turn into a file that cannot be opened at all — the
    // real click has to be free to try again and show a real error.
    const { fetchJson, calls } = fetcher({});

    const { result, rerender } = renderHook(
      ({ path }: { path: string | undefined }) =>
        useFileContent({ sessionId: SESSION, path, fetchJson }),
      { initialProps: { path: undefined as string | undefined } },
    );

    result.current.prefetch(["src/App.tsx"]);
    await waitFor(() => expect(calls.length).toBe(1));

    rerender({ path: "src/App.tsx" });

    await waitFor(() => expect(calls.length).toBe(2));
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

describe("useProjectFiles, while the log is busy", () => {
  /*
   * Every listing is a walk of the sandbox's filesystem. One per `file.changed` meant a replay
   * of a long session fired one per write it had ever made, and a turn writing twenty files
   * fired twenty — each flipping the tree to "loading" on its way.
   */
  const OTHER = "1c8f9f2e-4d3b-4e6c-8f7a-2b3c4d5e6f70";

  /** A server whose answers the test hands out one at a time, in whatever order it likes. */
  function heldServer() {
    const requests: {
      url: string;
      signal: AbortSignal | undefined;
      answer: (files: string[]) => void;
    }[] = [];
    const fetchJson = (url: string, init?: RequestInit): Promise<Response> =>
      new Promise((resolve) => {
        requests.push({
          url,
          signal: init?.signal ?? undefined,
          answer: (files) =>
            resolve(
              new Response(JSON.stringify({ ready: true, files, truncated: false }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            ),
        });
      });
    return { fetchJson, requests };
  }

  type Props = { sessionId: string; events: StoredEvent[]; replayed: boolean };

  function mount(fetchJson: (url: string, init?: RequestInit) => Promise<Response>, props: Props) {
    return renderHook((current: Props) => useProjectFiles({ ...current, fetchJson }), {
      initialProps: props,
    });
  }

  const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
  const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists nothing until the log has replayed, then lists once", async () => {
    vi.useFakeTimers();
    const server = heldServer();
    const history = [fileChanged("a.ts"), fileChanged("b.ts"), fileChanged("c.ts")];

    const { rerender, result } = mount(server.fetchJson, {
      sessionId: SESSION,
      events: [],
      replayed: false,
    });
    rerender({ sessionId: SESSION, events: history, replayed: false });
    await wait(LISTING_DEBOUNCE_MS * 2);
    expect(server.requests).toHaveLength(0);
    expect(result.current.status).toBe("loading");

    rerender({ sessionId: SESSION, events: history, replayed: true });
    await settle();

    // At once, not after the debounce: this is the listing somebody opening the project waits on.
    expect(server.requests).toHaveLength(1);
    await wait(LISTING_DEBOUNCE_MS * 2);
    expect(server.requests).toHaveLength(1);
  });

  it("lists once for a burst of changes, and keeps the previous list meanwhile", async () => {
    vi.useFakeTimers();
    const server = heldServer();
    let events: StoredEvent[] = [];
    const { rerender, result } = mount(server.fetchJson, {
      sessionId: SESSION,
      events,
      replayed: true,
    });
    await settle();
    await act(async () => server.requests[0]?.answer(["index.html"]));
    expect(result.current.status).toBe("ready");

    for (let i = 0; i < 8; i++) {
      events = [...events, fileChanged(`src/${i}.ts`)];
      rerender({ sessionId: SESSION, events, replayed: true });
      await wait(50);
    }
    await wait(LISTING_DEBOUNCE_MS);

    expect(server.requests).toHaveLength(2);
    // The refresh is in the air, and the tree still shows what it had rather than "loading".
    expect(result.current.status).toBe("ready");
    expect(result.current.listing?.files).toEqual(["index.html"]);

    await act(async () => server.requests[1]?.answer(["index.html", "src/0.ts"]));
    expect(result.current.listing?.files).toEqual(["index.html", "src/0.ts"]);
  });

  it("never lets an older answer replace a newer one", async () => {
    vi.useFakeTimers();
    const server = heldServer();
    let events: StoredEvent[] = [];
    const { rerender, result } = mount(server.fetchJson, {
      sessionId: SESSION,
      events,
      replayed: true,
    });
    await settle();
    await act(async () => server.requests[0]?.answer(["first"]));

    events = [...events, fileChanged("older.ts")];
    rerender({ sessionId: SESSION, events, replayed: true });
    await wait(LISTING_DEBOUNCE_MS);
    events = [...events, fileChanged("newer.ts")];
    rerender({ sessionId: SESSION, events, replayed: true });
    await wait(LISTING_DEBOUNCE_MS);
    expect(server.requests).toHaveLength(3);

    await act(async () => server.requests[2]?.answer(["newer"]));
    await act(async () => server.requests[1]?.answer(["older"]));

    expect(result.current.listing?.files).toEqual(["newer"]);
  });

  it("carries nothing of one session into the next", async () => {
    vi.useFakeTimers();
    const server = heldServer();
    let events: StoredEvent[] = [];
    const { rerender, result } = mount(server.fetchJson, {
      sessionId: SESSION,
      events,
      replayed: true,
    });
    await settle();
    await act(async () => server.requests[0]?.answer(["a's file"]));
    events = [...events, fileChanged("in-flight.ts")];
    rerender({ sessionId: SESSION, events, replayed: true });
    await wait(LISTING_DEBOUNCE_MS);
    // One of A's listings is in the air; another is waiting out its debounce.
    events = [...events, fileChanged("scheduled.ts")];
    rerender({ sessionId: SESSION, events, replayed: true });

    rerender({ sessionId: OTHER, events: [], replayed: false });
    expect(server.requests[1]?.signal?.aborted).toBe(true);
    await act(async () => server.requests[1]?.answer(["a's late answer"]));
    await wait(LISTING_DEBOUNCE_MS * 2);

    expect(server.requests).toHaveLength(2);
    expect(result.current.listing).toBeUndefined();
    expect(result.current.status).toBe("loading");
  });
});
