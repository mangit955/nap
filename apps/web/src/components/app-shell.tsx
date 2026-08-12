"use client";

import { useState } from "react";
import { type OpenProject, useProject } from "../projects/use-projects.ts";
import { Splitter } from "../ui/splitter.tsx";
import { LiveCodePane } from "../workspace/code-pane.tsx";
import { CHAT_SPLIT, DEFAULT_CHAT_WIDTH } from "../workspace/split.ts";
import type { WorkbenchTab } from "../workspace/tabs.ts";
import { usePaneWidth } from "../workspace/use-pane-width.ts";
import { Workbench } from "../workspace/workbench.tsx";
import { WorkspaceHeader } from "../workspace/workspace-header.tsx";
import { LiveChatPane } from "./chat-pane.tsx";
import { LiveConnectionStatus } from "./connection-status.tsx";
import { LivePreviewPane } from "./preview-pane.tsx";

/**
 * The workspace: a conversation on the left, and what it produced on the right.
 *
 * **Two columns, not three.** The files used to hold a permanent quarter of the window to show a
 * dozen names, and the preview — the thing anybody is actually watching — got whatever was left
 * in the middle. Now there is one workbench with two faces, and the tabs that switch them live
 * in the same bar as the project's name and the app's own controls.
 *
 * `h-dvh` with `min-h-0` on the panes is what keeps each pane scrolling independently instead of
 * the whole page growing.
 *
 * **The project is resolved once, here, and its session passed down.** Each pane subscribes to
 * that session independently, and several panes resolving it themselves would be several
 * requests for one answer. The session comes from the server rather than from the URL: which
 * conversation you land in is the project's newest one, and a link that named a session would go
 * stale as soon as the project grew another.
 */
export function AppShell({ projectId }: { projectId: string }) {
  const { project, status, putAwayAt, resume, resuming, resumeError, rename } =
    useProject(projectId);
  const sessionId = project?.sessionIds[0];

  const [tab, setTab] = useState<WorkbenchTab>("preview");
  const [chatOpen, setChatOpen] = useState(true);
  /**
   * Bumped by the bar's Reload button. A count rather than a boolean because the frame is keyed
   * on it: cross-origin means nothing here can call `reload()` on the app, so replacing the
   * element is the only reload available.
   */
  const [reloads, setReloads] = useState(0);
  const [route, setRoute] = useState("/");
  /** Reported by the preview pane, which is the one component already watching for it. */
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined);
  const { width, containerRef, onGrab, onKeyDown } = usePaneWidth(CHAT_SPLIT, DEFAULT_CHAT_WIDTH);

  return (
    <div className="flex h-dvh flex-col bg-surface">
      <WorkspaceHeader
        projectName={headerNote(status, project?.name)}
        // Only once there is a real record. While the bar is showing "opening…" or "this project
        // no longer exists", there is nothing a rename could be applied to.
        {...(status === "ready" && project !== undefined ? { onRename: rename } : {})}
        tab={tab}
        chatOpen={chatOpen}
        route={route}
        previewUrl={previewUrl}
        status={<LiveConnectionStatus sessionId={sessionId} />}
        onTabChange={setTab}
        onReload={() => setReloads((count) => count + 1)}
        onRouteChange={setRoute}
        onToggleChat={() => setChatOpen((open) => !open)}
      />

      <main
        ref={containerRef}
        className="grid min-h-0 flex-1"
        style={{ gridTemplateColumns: chatOpen ? `${width}px auto 1fr` : "1fr" }}
      >
        {chatOpen && (
          <>
            <LiveChatPane sessionId={sessionId} projectId={projectId} />

            <Splitter label="Chat width" value={width} onGrab={onGrab} onKeyDown={onKeyDown} />
          </>
        )}

        <Workbench
          tab={tab}
          preview={
            <LivePreviewPane
              sessionId={sessionId}
              route={route}
              reloads={reloads}
              onPreviewUrl={setPreviewUrl}
              onResume={() => void resume()}
              resuming={resuming}
              {...(putAwayAt === undefined ? {} : { putAwayAt })}
              {...(resumeError === undefined ? {} : { resumeError })}
            />
          }
          code={
            <LiveCodePane
              sessionId={sessionId}
              resuming={resuming}
              {...(putAwayAt === undefined ? {} : { putAwayAt })}
            />
          }
        />
      </main>
    </div>
  );
}

/**
 * What to call the project in the bar.
 *
 * A project deleted in another tab gets a sentence rather than a blank space: the panes below
 * sit empty either way, and "this project no longer exists" is the only version of that a person
 * can act on.
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
