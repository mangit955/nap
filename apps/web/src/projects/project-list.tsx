"use client";

/**
 * Everything you have made, most recently touched first.
 *
 * The first screen of the app, and the only one that is a list rather than a workspace. It is
 * deliberately plain: a name, when it last moved, what state it is in, and the three things
 * you can do to it. A project is a conversation and a running server, not a document, so the
 * row says which of those are true right now rather than showing a thumbnail of something that
 * may not be running.
 *
 * **State is a word, never a colour.** "running", "put away", "new" — the same rule the chat
 * pane follows, for the same reason: a dot tells a screen reader nothing and tells anybody who
 * cannot separate two hues the wrong thing.
 *
 * Split like the panes: this renders what it is given, and `LiveProjectList` owns the requests.
 * Deleting asks first, because it is the one action here that cannot be undone — the bytes go
 * too, and there is no snapshot left to open afterwards.
 */

import { type ProjectSummaryPayload, projectState } from "@nap/shared/projects-protocol";
import { useState } from "react";
import type { ProjectsStatus } from "./use-projects.ts";

export type ProjectListProps = {
  projects: readonly ProjectSummaryPayload[];
  status: ProjectsStatus;
  actionError: string | undefined;
  onCreate: () => void;
  onOpen: (project: ProjectSummaryPayload) => void;
  onClose: (projectId: string) => void;
  onDelete: (projectId: string) => void;
  /** Set while an action is in flight, so the row's buttons cannot be pressed twice. */
  busyProjectId?: string | undefined;
};

export function ProjectList({
  projects,
  status,
  actionError,
  onCreate,
  onOpen,
  onClose,
  onDelete,
  busyProjectId,
}: ProjectListProps) {
  const [confirming, setConfirming] = useState<string | undefined>(undefined);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-6 py-12">
      <header className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <h1 className="font-semibold text-ink text-lg tracking-tight">nap</h1>
          <p className="text-muted text-xs">describe an app, watch it get built</p>
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="rounded border border-accent px-3 py-1.5 font-medium text-accent text-xs hover:bg-accent/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        >
          New project
        </button>
      </header>

      {actionError !== undefined && (
        // A live region: this appears in response to something the user just pressed, and a
        // message that only changes visually is one a screen reader never mentions.
        <p role="alert" className="font-mono text-danger text-xs">
          {actionError}
        </p>
      )}

      {status === "loading" && <p className="text-muted text-sm">Loading your projects…</p>}

      {status === "error" && (
        <p className="text-danger text-sm">
          Could not reach the server. Check that the API is running, then reload.
        </p>
      )}

      {status === "ready" && projects.length === 0 && (
        <p className="text-muted text-sm">
          Nothing here yet. Start one with <span className="text-ink">New project</span>.
        </p>
      )}

      {projects.length > 0 && (
        <ul className="flex flex-col divide-y divide-edge border-edge border-y">
          {projects.map((project) => (
            <li key={project.projectId} className="flex items-center justify-between gap-4 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => onOpen(project)}
                  className="truncate text-left font-medium text-ink text-sm hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                >
                  {project.name}
                </button>
                <p className="font-mono text-[11px] text-muted">
                  {projectState(project)} · {relativeTime(project.updatedAt)}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2 font-mono text-[11px]">
                {project.sandboxId !== null && (
                  <button
                    type="button"
                    disabled={busyProjectId === project.projectId}
                    onClick={() => onClose(project.projectId)}
                    className="text-muted hover:text-ink disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                  >
                    Close
                  </button>
                )}

                {confirming === project.projectId ? (
                  <span className="flex items-center gap-2">
                    <span className="text-muted">Delete for good?</span>
                    <button
                      type="button"
                      disabled={busyProjectId === project.projectId}
                      onClick={() => {
                        setConfirming(undefined);
                        onDelete(project.projectId);
                      }}
                      className="text-danger hover:underline disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                    >
                      Yes, delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(undefined)}
                      className="text-muted hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                    >
                      Keep
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={busyProjectId === project.projectId}
                    onClick={() => setConfirming(project.projectId)}
                    className="text-muted hover:text-danger disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/**
 * How long ago, in the roundest words that are still true.
 *
 * Exact timestamps are noise on a list whose only job is "which one was I just in" — and a
 * localized absolute time would differ between the server render and the browser's, which
 * React reports as a hydration mismatch.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
