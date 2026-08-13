"use client";

import { useEffect, useRef, useState } from "react";
import { type OpenProject, useProject } from "../projects/use-projects.ts";
import { Splitter } from "../ui/splitter.tsx";
import { LiveCodePane } from "../workspace/code-pane.tsx";
import { CHAT_SPLIT, DEFAULT_CHAT_WIDTH } from "../workspace/split.ts";
import { isStartingUp } from "../workspace/starting-up.ts";
import type { WorkbenchTab } from "../workspace/tabs.ts";
import { usePaneWidth } from "../workspace/use-pane-width.ts";
import { Workbench } from "../workspace/workbench.tsx";
import { WorkspaceHeader } from "../workspace/workspace-header.tsx";
import { LiveChatPane } from "./chat-pane.tsx";
import { LivePreviewPane } from "./preview-pane.tsx";

/**
 * The workspace: a conversation on the left, and what it produced on the right.
 *
 * **Two columns, not three.** The files used to hold a permanent quarter of the window to show a
 * dozen names, and the preview — the thing anybody is actually watching — got whatever was left
 * in the middle. Now there is one workbench with two faces, and the tabs that switch them live
 * in the same bar as the project's name and the app's own controls.
 *
 * **The frame clips and the panes scroll, and it takes both to hold.** `h-dvh` fixes the height and
 * `min-h-0` stops a pane forcing its track taller — but neither *contains* a child that overflows
 * anyway, and there is no scroll container between here and the document. So one leaking row in the
 * transcript used to scroll the entire page, top bar and all, out of the window. The two
 * `overflow-hidden`s below are what make that impossible rather than unlikely: scrolling belongs to
 * the iframe, the file viewer, the tree and the transcript, and nowhere else.
 *
 * **The project is resolved once, here, and its session passed down.** Each pane subscribes to
 * that session independently, and several panes resolving it themselves would be several
 * requests for one answer. The session comes from the server rather than from the URL: which
 * conversation you land in is the project's newest one, and a link that named a session would go
 * stale as soon as the project grew another.
 */
export function AppShell({ projectId }: { projectId: string }) {
  /**
   * The preview announcement the panes are currently looking at, reported up by the pane that
   * holds the subscription. Two things read it: the bar, which offers to open the address in a
   * tab, and the project hook, which uses the `seq` to know that a restore it asked for has
   * actually come up.
   */
  const [ready, setReady] = useState<{ url: string; seq: number } | undefined>(undefined);
  const { project, status, putAwayAt, resume, resuming, resumeError, rename } = useProject(
    projectId,
    { previewSeq: ready?.seq },
  );
  const sessionId = project?.sessionIds[0];

  /**
   * Which project this page has already asked to start, so it never asks twice.
   *
   * A refused resume — the sandbox quota answers 409 — deliberately leaves the record saying
   * the project is put away, so without this a re-render would fire the request again, and
   * again. One attempt per project; if it fails, the pane's own Resume button is the retry.
   */
  const started = useRef<string | undefined>(undefined);

  /**
   * Opening a project starts it. Nobody navigates to their own app to be asked whether they
   * meant it — the button that used to be the only way in is now the fallback for a start that
   * was refused.
   *
   * Only for a project the server says is put away. One that has never run reports no
   * `putAwayAt` at all, and starting a sandbox for it would spend a minute of somebody's quota
   * on an empty template; its first prompt is what brings it up.
   */
  useEffect(() => {
    if (status !== "ready" || putAwayAt === undefined) return;
    if (started.current === projectId) return;

    started.current = projectId;
    void resume();
  }, [status, putAwayAt, projectId, resume]);

  const startingUp = isStartingUp({ status, resuming, putAwayAt, resumeError });

  const [tab, setTab] = useState<WorkbenchTab>("preview");
  const [chatOpen, setChatOpen] = useState(true);
  /**
   * Bumped by the bar's Reload button. A count rather than a boolean because the frame is keyed
   * on it: cross-origin means nothing here can call `reload()` on the app, so replacing the
   * element is the only reload available.
   */
  const [reloads, setReloads] = useState(0);
  const [route, setRoute] = useState("/");
  const { width, containerRef, onGrab, onKeyDown } = usePaneWidth(CHAT_SPLIT, DEFAULT_CHAT_WIDTH);

  return (
    // Scoped here rather than as `body { overflow: hidden }`: the landing page and the welcome
    // step are full-length scrolling documents, and a global rule would break both.
    <div className="flex h-dvh flex-col overflow-hidden bg-surface">
      <WorkspaceHeader
        projectName={headerNote(status, project?.name)}
        // Only once there is a real record. While the bar is showing "opening…" or "this project
        // no longer exists", there is nothing a rename could be applied to.
        {...(status === "ready" && project !== undefined ? { onRename: rename } : {})}
        tab={tab}
        chatOpen={chatOpen}
        route={route}
        previewUrl={ready?.url}
        onTabChange={setTab}
        onReload={() => setReloads((count) => count + 1)}
        onRouteChange={setRoute}
        onToggleChat={() => setChatOpen((open) => !open)}
      />

      <main
        ref={containerRef}
        // The second clamp, and not a redundant one: this catches whatever a pane leaks, the root
        // above catches the header and anything drawn outside this grid.
        className="grid min-h-0 flex-1 overflow-hidden"
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
              onPreviewReady={setReady}
              onResume={() => void resume()}
              resuming={startingUp}
              {...(putAwayAt === undefined ? {} : { putAwayAt })}
              {...(resumeError === undefined ? {} : { resumeError })}
            />
          }
          code={
            <LiveCodePane
              sessionId={sessionId}
              active={tab === "code"}
              resuming={startingUp}
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
