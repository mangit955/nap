"use client";

import { useEffect, useRef, useState } from "react";
import { type FetchJson, useProjectFiles } from "../files/use-project-files.ts";
import type { CreateSocket } from "../hooks/use-event-stream.ts";
import { useSessionLog } from "../hooks/use-session-log.ts";
import { phaseOf, recordState } from "../projects/project-phase.ts";
import { type OpenProject, useProject } from "../projects/use-projects.ts";
import { Splitter } from "../ui/splitter.tsx";
import { useDocumentScrollLock } from "../ui/use-document-scroll-lock.ts";
import { LiveCodePane } from "../workspace/code-pane.tsx";
import { CHAT_SPLIT, DEFAULT_CHAT_WIDTH } from "../workspace/split.ts";
import type { WorkbenchTab } from "../workspace/tabs.ts";
import { usePaneWidth } from "../workspace/use-pane-width.ts";
import { Workbench } from "../workspace/workbench.tsx";
import { WorkspaceHeader } from "../workspace/workspace-header.tsx";
import { LiveChatPane } from "./chat-pane.tsx";
import { PreviewPane } from "./preview-pane.tsx";

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
 * **And a clamp only clips what it is the containing block for**, which is the half that was
 * missing. Both boxes were `static`, so every absolutely positioned descendant — which is every
 * `sr-only` label in the transcript, and each pane's own heading — resolved against the initial
 * containing block and sailed straight through both. One of them below the fold is enough to
 * lengthen the document, and then the window scrolls and takes the header with it. `relative` is
 * what makes the clamps mean what the paragraph above claims; `useDocumentScrollLock` catches
 * whatever a later pane invents.
 *
 * **The project, its log and its file listing are resolved once, here.** Each pane used to
 * subscribe for itself, which was three sockets carrying identical frames and two panes free to
 * disagree about what the newest event was; the listing was fetched twice for the same reason.
 * The session comes from the server rather than from the URL: which conversation you land in is
 * the project's newest one, and a link that named a session would go stale as soon as the project
 * grew another.
 */
export function AppShell({
  projectId,
  fetchJson,
  createSocket,
}: {
  projectId: string;
  /**
   * The two ways out of this page — HTTP and a socket — as arguments rather than as imports.
   *
   * Every hook underneath already takes them; taking them here is what lets a test drive the
   * whole workspace, including the wiring between the panes, without mocking the modules it is
   * trying to test. Production passes neither.
   */
  fetchJson?: FetchJson | undefined;
  createSocket?: CreateSocket | undefined;
}) {
  /**
   * The `seq` of the newest preview announcement the workspace has seen.
   *
   * It is a sequence number rather than a flag because a project put away and started again has
   * two `preview.ready` events in its log: only an announcement newer than the one standing when
   * the restore was asked for means *this* restore came up. Held in state and fed from an effect
   * because the log cannot be read before the project it belongs to has been fetched — the
   * session id comes from the record — so the answer is always one frame behind the fetch.
   */
  const [previewSeq, setPreviewSeq] = useState<number | undefined>(undefined);

  const { project, status, putAwayAt, resume, resuming, resumeError, rename } = useProject(
    projectId,
    { previewSeq, ...(fetchJson === undefined ? {} : { fetchJson }) },
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

  const log = useSessionLog({
    sessionId,
    ...(createSocket === undefined ? {} : { createSocket }),
  });

  /**
   * What this project is doing — one answer, read by both halves of the workbench and by nothing
   * else. Five modules used to derive it independently, which is how the preview and the file tree
   * came to disagree about whether a project was running.
   */
  const phase = phaseOf({
    status,
    record: recordState(project),
    putAwayAt,
    preview: log.preview,
    replayed: log.replayed,
    resuming,
    resumeError,
  });

  // The restore's own end condition, reported to the hook that is waiting for it. In an effect
  // rather than during render because it feeds a hook that has already run this frame.
  const announced = log.preview.status === "ready" ? log.preview.seq : undefined;
  useEffect(() => {
    setPreviewSeq(announced);
  }, [announced]);

  const previewUrl = phase.kind === "running" ? phase.url : undefined;

  const files = useProjectFiles({
    sessionId,
    events: log.events,
    ...(fetchJson === undefined ? {} : { fetchJson }),
  });

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

  useDocumentScrollLock();

  return (
    // Scoped here rather than as `body { overflow: hidden }`: the landing page and the welcome
    // step are full-length scrolling documents, and a global rule would break both.
    <div className="relative flex h-dvh flex-col overflow-hidden bg-surface">
      <WorkspaceHeader
        projectName={headerNote(status, project?.name)}
        // Only once there is a real record. While the bar is showing "opening…" or "this project
        // no longer exists", there is nothing a rename could be applied to.
        {...(status === "ready" && project !== undefined ? { onRename: rename } : {})}
        tab={tab}
        chatOpen={chatOpen}
        route={route}
        previewUrl={previewUrl}
        // The strip that otherwise carries this lives inside the chat pane, and the button that
        // collapses that pane is in this bar — so without it here the confidence signal
        // disappears exactly when the preview takes the whole window. One value, so the bar and
        // the strip cannot say different things about one job.
        job={log.jobs.summary}
        onTabChange={setTab}
        onReload={() => setReloads((count) => count + 1)}
        onRouteChange={setRoute}
        onToggleChat={() => setChatOpen((open) => !open)}
      />

      <main
        ref={containerRef}
        // The second clamp, and not a redundant one: this catches whatever a pane leaks, the root
        // above catches the header and anything drawn outside this grid.
        className="relative grid min-h-0 flex-1 overflow-hidden"
        style={{ gridTemplateColumns: chatOpen ? `${width}px auto 1fr` : "1fr" }}
      >
        {chatOpen && (
          <>
            <LiveChatPane
              sessionId={sessionId}
              projectId={projectId}
              log={log}
              files={files.listing?.files}
              {...(fetchJson === undefined ? {} : { fetchJson })}
            />

            <Splitter label="Chat width" value={width} onGrab={onGrab} onKeyDown={onKeyDown} />
          </>
        )}

        <Workbench
          tab={tab}
          preview={
            <PreviewPane
              phase={phase}
              route={route}
              reloads={reloads}
              onResume={() => void resume()}
              {...(resumeError === undefined ? {} : { resumeError })}
            />
          }
          code={
            <LiveCodePane
              sessionId={sessionId}
              active={tab === "code"}
              log={log}
              phase={phase}
              files={files}
              {...(fetchJson === undefined ? {} : { fetchJson })}
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
