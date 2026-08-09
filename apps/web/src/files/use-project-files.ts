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
import { useEffect, useState } from "react";
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
   * What makes the listing stale, as one number. A file the agent wrote is the obvious case;
   * a finished turn is the one that is easy to miss, because a command like `bun add` changes
   * a project without producing a single `file.changed`.
   */
  const staleness = changeCount(events) + events.filter((e) => e.type === "turn.completed").length;

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
};

export function useFileContent(options: Request & { path: string | undefined }): SelectedFile {
  const { sessionId, path, baseUrl = DEFAULT_BASE_URL } = options;
  const fetchJson = options.fetchJson ?? defaultFetch;

  const [file, setFile] = useState<FileContent | undefined>(undefined);
  const [status, setStatus] = useState<LoadStatus>("idle");

  // biome-ignore lint/correctness/useExhaustiveDependencies: see the note in useProjectFiles
  useEffect(() => {
    if (sessionId === undefined || path === undefined) {
      setStatus("idle");
      setFile(undefined);
      return;
    }

    let abandoned = false;
    setStatus("loading");

    void (async () => {
      const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`;
      const result = await load(fetchJson, url, FileContentSchema);
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
  }, [sessionId, path, baseUrl]);

  return { file, status };
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

const defaultFetch: FetchJson = (url) => fetch(url);
