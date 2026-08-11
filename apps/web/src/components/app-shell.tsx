"use client";

import { NapMark } from "../brand/nap-mark.tsx";
import { type OpenProject, useProject } from "../projects/use-projects.ts";
import { LiveChatPane } from "./chat-pane.tsx";
import { LiveConnectionStatus } from "./connection-status.tsx";
import { LiveFileTreePane } from "./file-tree-pane.tsx";
import { LivePreviewPane } from "./preview-pane.tsx";

/**
 * The three-pane frame: chat | preview | file tree.
 *
 * Proportions rather than equal thirds — chat and files are reference widths that stay
 * readable, and the preview takes everything left over, because it is the thing the user
 * is actually looking at. Fixed columns also stop the preview from reflowing every time a
 * long tool result lands in the transcript.
 *
 * `h-dvh` with `min-h-0` on the panes is what keeps each pane scrolling independently
 * instead of the whole page growing.
 *
 * **The project is resolved once, here, and its session passed down.** Each pane subscribes to
 * that session independently, and four panes resolving it themselves would be four requests
 * for one answer. The session comes from the server rather than from the URL: which
 * conversation you land in is the project's newest one, and a link that named a session would
 * go stale as soon as the project grew another.
 */
export function AppShell({ projectId }: { projectId: string }) {
  const { project, status, putAway, resume, resuming, resumeError } = useProject(projectId);
  const sessionId = project?.sessionIds[0];

  return (
    <div className="flex h-dvh flex-col bg-surface">
      <header className="flex h-12 shrink-0 items-center justify-between border-edge border-b px-4">
        <div className="flex items-baseline gap-2">
          {/*
            A plain anchor rather than a router link: leaving the workspace should drop the
            socket and every pending request, and a full navigation is the simplest thing that
            actually does that.
          */}
          <a
            href="/"
            className="flex items-center gap-1.5 font-semibold text-ink text-sm tracking-tight hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          >
            <NapMark className="size-6" />
            nap
          </a>
          <span className="text-muted text-xs">{headerNote(status, project?.name)}</span>
        </div>
        <LiveConnectionStatus sessionId={sessionId} />
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[360px_1fr_260px] gap-px bg-edge">
        <LiveChatPane sessionId={sessionId} projectId={projectId} />
        <LivePreviewPane
          sessionId={sessionId}
          putAway={putAway}
          onResume={() => void resume()}
          resuming={resuming}
          {...(resumeError === undefined ? {} : { resumeError })}
        />
        <LiveFileTreePane sessionId={sessionId} putAway={putAway && !resuming} />
      </main>
    </div>
  );
}

/**
 * What to say beside the product name.
 *
 * A project deleted in another tab gets a sentence rather than a blank space: the panes below
 * sit empty either way, and "this project no longer exists" is the only version of that a
 * person can act on.
 */
function headerNote(status: OpenProject["status"], name: string | undefined): string {
  switch (status) {
    case "loading":
      return "opening…";
    case "missing":
      return "this project no longer exists";
    case "error":
      return "could not reach the server";
    default:
      return name ?? "untitled project";
  }
}
