"use client";

/**
 * Reading a project's files over HTTP.
 *
 * Two requests, both read-only: the listing behind the tree, and one file's contents behind
 * the viewer. Neither is a subscription — files change when a turn changes them, so the event
 * stream is what says *when* to ask again, and asking on every event would put a request
 * behind each token the model streams.
 *
 * `fetch` comes in through an argument, the way `useEventStream` takes a socket factory, so
 * the tests drive every branch — including a response that arrives after the user moved on —
 * without the suite going anywhere near a network.
 *
 * Both responses are parsed through the shared schemas rather than trusted. A malformed body
 * is reported as a failure, because a tree silently rendering nothing looks exactly like a
 * project with no files in it.
 */

import {
  type FileContent,
  FileContentSchema,
  type FileListing,
  FileListingSchema,
} from "@nap/shared/files-protocol";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useCallback, useEffect, useRef, useState } from "react";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import { changeCount } from "./changed-paths.ts";

/**
 * The seam every request in the app goes through. Shaped like `fetch` rather than narrower,
 * because the write side needs a method and a body — and a second seam for those would mean
 * a test could stub one and miss the other.
 */
export type FetchJson = (url: string, init?: RequestInit) => Promise<Response>;

export type LoadStatus = "idle" | "loading" | "ready" | "error";

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

type Request = {
  sessionId: string | undefined;
  baseUrl?: string;
  fetchJson?: FetchJson;
};

export type ProjectFiles = {
  listing: FileListing | undefined;
  status: LoadStatus;
};

export function useProjectFiles(
  options: Request & { events: readonly StoredEvent[] },
): ProjectFiles {
  const { sessionId, events, baseUrl = DEFAULT_BASE_URL } = options;
  const fetchJson = options.fetchJson ?? defaultFetch;

  const [listing, setListing] = useState<FileListing | undefined>(undefined);
  const [status, setStatus] = useState<LoadStatus>(sessionId === undefined ? "idle" : "loading");

  /**
   * What makes the listing stale, as one number. A file the agent wrote is the obvious case; a
   * finished turn is the one that is easy to miss, because a command like `bun add` changes a
   * project without producing a single `file.changed`. A sandbox coming up is the third: it is
   * a *new filesystem*, and the moment the endpoint stops answering `ready: false` — without it
   * the tree sits on that answer until the agent happens to write something.
   */
  const staleness = stalenessOf(events);

  // `fetchJson` is deliberately not a dependency: an inline arrow is a new function on every
  // render, and refetching the whole project each time is not what a caller means by passing
  // one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (sessionId === undefined) {
      setStatus("idle");
      setListing(undefined);
      return;
    }

    let abandoned = false;
    setStatus("loading");

    void (async () => {
      const result = await load(
        fetchJson,
        `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/files`,
        FileListingSchema,
      );
      if (abandoned) return;

      if (result === undefined) {
        setStatus("error");
        setListing(undefined);
        return;
      }
      setListing(result);
      setStatus("ready");
    })();

    return () => {
      // A response for a session the pane has left must not land in the pane it moved to.
      abandoned = true;
    };
  }, [sessionId, baseUrl, staleness]);

  return { listing, status };
}

export type SelectedFile = {
  file: FileContent | undefined;
  status: LoadStatus;
  /**
   * Reads files into the cache before anybody asks for them, so the *first* click is instant
   * too — caching alone only ever helped the second.
   */
  prefetch: (paths: readonly string[]) => void;
};

/**
 * How many reads may be in the air at once.
 *
 * The listing allows up to 500 entries (`DEFAULT_MAX_ENTRIES` in
 * `packages/sandbox/src/project-files.ts`), and every read is a call into the sandbox — firing
 * them all at once would make browsing the files hostile to the turn running beside it.
 */
const PREFETCH_CONCURRENCY = 4;

/**
 * One file's contents, **kept once they have been read**.
 *
 * Every read is a round trip from the browser to the API to the sandbox, and the sandbox hop is
 * the slow part. Nothing can make that request fast; what a cache does is avoid making it at all
 * for a file already on this machine — clicking back and forth between two files went from two
 * network round trips to none, which is the whole of the "it does not feel snappy" complaint.
 *
 * **The cache is dropped wholesale whenever the project changes**, on the same `staleness` count
 * the listing uses rather than a second rule of its own. Coarse on purpose: throwing everything
 * away when anything changed is obviously correct, where invalidating per path is a second piece
 * of bookkeeping to keep in step for no gain at a dozen files. A stale file shown as current is
 * a much worse failure than a re-read.
 */
export function useFileContent(
  options: Request & { path: string | undefined; events?: readonly StoredEvent[] },
): SelectedFile {
  const { sessionId, path, events = [], baseUrl = DEFAULT_BASE_URL } = options;
  const fetchJson = options.fetchJson ?? defaultFetch;

  const [file, setFile] = useState<FileContent | undefined>(undefined);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const cache = useRef(new Map<string, FileContent>());
  /**
   * The read in progress for each path, as a promise rather than a flag.
   *
   * A flag was not enough and a test caught it: hovering a row starts a prefetch, and clicking
   * it a moment later found nothing in the cache — because the answer had not landed yet — and
   * fired a *second* read for the same file. Holding the promise lets the click join the read
   * already running, so hovering makes things faster and never slower.
   */
  const inFlight = useRef(new Map<string, Promise<FileContent | undefined>>());

  const staleness = stalenessOf(events);

  // Emptied during render rather than in an effect: an effect runs *after* the one below, so a
  // stale entry would be served for a frame before being thrown away — and that frame is what
  // the user would see.
  const lastStaleness = useRef(staleness);
  if (lastStaleness.current !== staleness) {
    lastStaleness.current = staleness;
    cache.current.clear();
  }

  /**
   * One read per path, however many callers want it.
   *
   * Both the selection effect and the prefetcher go through here, which is what makes the two
   * unable to duplicate each other's work.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: see the note in useProjectFiles
  const read = useCallback(
    (path: string): Promise<FileContent | undefined> => {
      if (sessionId === undefined) return Promise.resolve(undefined);

      const running = inFlight.current.get(path);
      if (running !== undefined) return running;

      const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`;
      const pending = load(fetchJson, url, FileContentSchema).then((result) => {
        inFlight.current.delete(path);
        // Only a file that arrived is remembered. Caching a failure would turn one blip into a
        // file that cannot be opened until the next turn.
        if (result !== undefined) cache.current.set(path, result);
        return result;
      });

      inFlight.current.set(path, pending);
      return pending;
    },
    [sessionId, baseUrl],
  );

  const prefetch = useCallback(
    (paths: readonly string[]) => {
      if (sessionId === undefined) return;

      const queue = paths.filter((path) => !cache.current.has(path) && !inFlight.current.has(path));
      if (queue.length === 0) return;

      // A fixed number of workers pulling from one queue, rather than a request per path: this
      // is what bounds the load on the sandbox regardless of how big the project is.
      const worker = async () => {
        for (;;) {
          const path = queue.shift();
          if (path === undefined) return;
          await read(path);
        }
      };

      for (let i = 0; i < Math.min(PREFETCH_CONCURRENCY, queue.length); i++) void worker();
    },
    [sessionId, read],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: see the note in useProjectFiles
  useEffect(() => {
    if (sessionId === undefined || path === undefined) {
      setStatus("idle");
      setFile(undefined);
      return;
    }

    const cached = cache.current.get(path);
    if (cached !== undefined) {
      // No request, and no `loading` in between: a flash of "Loading…" for a file already in
      // memory is exactly the stutter this exists to remove.
      setFile(cached);
      setStatus("ready");
      return;
    }

    let abandoned = false;
    setStatus("loading");

    void (async () => {
      // Joins a read already running for this path — a row that was hovered a moment ago — so
      // hovering can only ever help.
      const result = await read(path);
      // Clicking two files in quick succession is ordinary, and nothing promises the answers
      // come back in that order. Without this the first file's contents appear under the
      // second file's name.
      if (abandoned) return;

      if (result === undefined) {
        setStatus("error");
        setFile(undefined);
        return;
      }
      setFile(result);
      setStatus("ready");
    })();

    return () => {
      abandoned = true;
    };
  }, [sessionId, path, baseUrl, staleness, read]);

  return { file, status, prefetch };
}

/**
 * What makes anything read from the sandbox stale, as one number.
 *
 * A file the agent wrote is the obvious case; a finished turn is the one that is easy to miss,
 * because a command like `bun add` changes a project without producing a single `file.changed`.
 * A sandbox coming up is the third: it is a *new filesystem*, and the moment the endpoint stops
 * answering `ready: false` — without it the tree sits on that answer until the agent happens to
 * write something.
 *
 * One function for the listing and the file cache, so the two cannot disagree about when the
 * project moved underneath them.
 */
function stalenessOf(events: readonly StoredEvent[]): number {
  return (
    changeCount(events) +
    events.filter((e) => e.type === "turn.completed" || e.type === "preview.ready").length
  );
}

/** `undefined` for anything that did not come back as the shape it promised. */
async function load<T>(
  fetchJson: FetchJson,
  url: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
): Promise<T | undefined> {
  try {
    const response = await fetchJson(url);
    if (!response.ok) return undefined;

    const parsed = schema.safeParse(await response.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    // An offline browser and a server that is restarting both land here. The pane says it
    // could not read the files; the next turn's events will make it try again.
    return undefined;
  }
}

const defaultFetch: FetchJson = credentialedFetch;
