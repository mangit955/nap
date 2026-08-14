"use client";

/**
 * One session's event log, and the questions the workspace asks of it.
 *
 * **One socket per workspace, not one per pane.** Every `useEventStream` call is a connection of
 * its own — its own replay, its own backoff curve, its own `seq`. Three panes calling it for the
 * same session meant three sockets carrying identical frames, and two panes could sit at
 * different sequence numbers in one frame: the preview offering the address of a sandbox the
 * transcript had already watched stop. So the subscription happens once, above the panes, and
 * they are handed the answers.
 *
 * **The folds live here because more than one pane needs each of them.** Folding the same log
 * twice for one answer is how two halves of a screen end up disagreeing. Anything only one
 * component reads — the transcript, its step groups — stays where it is read.
 *
 * What this module deliberately does *not* answer is whether a project is running: that needs the
 * project record and the request this page has made, neither of which is the log. See
 * `projects/project-phase.ts`.
 *
 * The socket factory and base URL pass straight through, so a test drives a whole workspace
 * against a fake socket with no network anywhere near it.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useMemo } from "react";
import { changedPaths } from "../files/changed-paths.ts";
import { type PreviewState, previewState } from "../preview/preview-state.ts";
import { type CreateSocket, type StreamStatus, useEventStream } from "./use-event-stream.ts";

export type SessionLog = {
  events: readonly StoredEvent[];
  status: StreamStatus;
  /** The highest sequence number received; where a reconnect resumes from. */
  lastSeq: number;
  /** Whether the server has said it sent everything it had. See `useEventStream`. */
  replayed: boolean;
  /** What is serving the project, as the log last described it. */
  preview: PreviewState;
  /** Project-relative paths this session has written. */
  changed: ReadonlySet<string>;
};

export function useSessionLog(options: {
  sessionId: string | undefined;
  baseUrl?: string;
  createSocket?: CreateSocket;
}): SessionLog {
  const { sessionId, baseUrl, createSocket } = options;

  const { events, status, lastSeq, replayed } = useEventStream({
    sessionId,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(createSocket === undefined ? {} : { createSocket }),
  });

  // Keyed on the array rather than its length: the log is append-only and the hook hands back a
  // new array for every event, so identity changes exactly when the answers could have.
  const preview = useMemo(() => previewState(events), [events]);
  const changed = useMemo(() => changedPaths(events), [events]);

  return { events, status, lastSeq, replayed, preview, changed };
}
