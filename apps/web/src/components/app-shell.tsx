"use client";

import type { ProjectRepository } from "@nap/shared/github-protocol";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TurnActivity } from "../chat/use-turn-submission.ts";
import { foldAppTests } from "../computer/app-test-state.ts";
import { computerIsBusy } from "../computer/computer-activity.ts";
import { ComputerPane } from "../computer/computer-pane.tsx";
import { ComputerNavigation } from "../computer/navigation.tsx";
import { RecordingNavigation } from "../computer/recording-navigation.tsx";
import { type RecordingView, RecordingViewer } from "../computer/recording-viewer.tsx";
import { type FetchJson, useProjectFiles } from "../files/use-project-files.ts";
import { ProjectGitHubControl } from "../github/project-github.tsx";
import type { CreateSocket } from "../hooks/use-event-stream.ts";
import { useSessionLog } from "../hooks/use-session-log.ts";
import { phaseOf, recordState } from "../projects/project-phase.ts";
import { type OpenProject, useProject } from "../projects/use-projects.ts";
import { Splitter } from "../ui/splitter.tsx";
import { useDocumentScrollLock } from "../ui/use-document-scroll-lock.ts";
import { BrowserToolbar } from "../workspace/browser-toolbar.tsx";
import { ChangesPanel } from "../workspace/changes-panel.tsx";
import { FilePanel } from "../workspace/file-panel.tsx";
import { PANEL_SPLIT } from "../workspace/split.ts";
import { ThreadDetailsPanel, useThreadDetails } from "../workspace/thread-details.tsx";
import { useNarrowPanel } from "../workspace/use-narrow-panel.ts";
import { usePaneWidth } from "../workspace/use-pane-width.ts";
import { usePanelLayout } from "../workspace/use-panel-layout.ts";
import { Workbench } from "../workspace/workbench.tsx";
import { WorkspaceHeader } from "../workspace/workspace-header.tsx";
import { LiveChatPane } from "./chat-pane.tsx";
import { FileTreePane } from "./file-tree-pane.tsx";
import { PreviewPane } from "./preview-pane.tsx";

export function AppShell({
  ownerId,
  projectId,
  fetchJson,
  createSocket,
}: {
  ownerId?: string | undefined;
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
  const [projectRefreshKey, setProjectRefreshKey] = useState(0);
  const [repository, setRepository] = useState<ProjectRepository | null>();
  const [runningPreviewPort, setRunningPreviewPort] = useState<number | null>();
  const receiveRepository = useCallback(
    (next: ProjectRepository | null, runningPort?: number | null) => {
      setRepository(next);
      setRunningPreviewPort(runningPort);
    },
    [],
  );
  const [activePreview, setActivePreview] = useState<{
    projectId: string;
    sandboxId: string;
    required: boolean;
  } | null>(null);
  const configuredPreviewRequired =
    repository?.projectId !== projectId || repository.environment.previewPort !== null;
  const previewRequired =
    repository?.projectId === projectId && runningPreviewPort !== undefined
      ? runningPreviewPort !== null
      : activePreview?.projectId === projectId
        ? activePreview.required
        : configuredPreviewRequired;

  const { project, status, putAwayAt, resume, resuming, resumeError, rename } = useProject(
    projectId,
    {
      previewSeq,
      previewRequired,
      refreshKey: projectRefreshKey,
      ...(fetchJson === undefined ? {} : { fetchJson }),
    },
  );
  const sessionId = project?.sessionIds[0];

  // Saving environment settings changes the next workspace, not the sandbox already running.
  useEffect(() => {
    const sandboxId = project?.sandboxId;
    if (sandboxId == null) {
      setActivePreview(null);
      return;
    }
    if (repository?.projectId !== projectId) return;
    const required =
      runningPreviewPort === undefined ? configuredPreviewRequired : runningPreviewPort !== null;
    setActivePreview((current) =>
      current?.projectId === projectId &&
      current.sandboxId === sandboxId &&
      (runningPreviewPort === undefined || current.required === required)
        ? current
        : { projectId, sandboxId, required },
    );
  }, [
    projectId,
    project?.sandboxId,
    repository?.projectId,
    configuredPreviewRequired,
    runningPreviewPort,
  ]);

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
    previewRequired,
  });

  // The restore's own end condition, reported to the hook that is waiting for it. In an effect
  // rather than during render because it feeds a hook that has already run this frame.
  const announced = log.preview.status === "ready" ? log.preview.seq : undefined;
  useEffect(() => {
    setPreviewSeq(announced);
  }, [announced]);

  const previewUrl = phase.kind === "running" ? phase.url : undefined;
  const githubRevision =
    log.events.findLast(
      (event) =>
        event.type === "system.notice" ||
        event.type === "preview.ready" ||
        event.type === "preview.stopped" ||
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "verification.completed",
    )?.seq ?? 0;
  const projectRevision =
    log.events.findLast(
      (event) => event.type === "system.notice" || event.type === "preview.stopped",
    )?.seq ?? 0;
  useEffect(() => {
    setProjectRefreshKey(projectRevision);
  }, [projectRevision]);

  const files = useProjectFiles({
    sessionId,
    events: log.events,
    ...(fetchJson === undefined ? {} : { fetchJson }),
  });

  const panels = usePanelLayout(`${ownerId ?? "guest"}:${projectId}:${sessionId ?? "pending"}`);
  const [maximized, setMaximized] = useState(false);
  const openPopout = useEffectEvent(() => {
    panels.open({ kind: "computer" });
    setMaximized(true);
  });
  useEffect(() => {
    if (sessionId && new URLSearchParams(window.location.search).get("panel") === "computer")
      openPopout();
  }, [sessionId]);
  const [reloads, setReloads] = useState(0);
  const [route, setRoute] = useState("/");
  const { width, containerRef, onGrab, onKeyDown } = usePaneWidth(PANEL_SPLIT, 540);
  useDocumentScrollLock();
  const paneStyle: CSSProperties & { "--panel-width": string } = { "--panel-width": `${width}px` };
  const [computerPosition, setComputerPosition] = useState<{
    sessionId: string | undefined;
    seq: number | null;
  } | null>(null);
  const computerSeq =
    computerPosition && computerPosition.sessionId === sessionId ? computerPosition.seq : null;
  const seekComputer = (seq: number | null) => setComputerPosition({ sessionId, seq });
  const openComputer = (seq: number | null) => {
    seekComputer(seq);
    panels.open({ kind: "computer" });
  };
  const openFile = (path: string) => panels.open({ kind: "file", path });
  const visiblePanel = panels.layout.open;
  const tests = useMemo(() => foldAppTests(log.events), [log.events]);
  const [turnActivity, setTurnActivity] = useState<TurnActivity | null>(null);
  const computerBusy = computerIsBusy({ sessionId, events: log.events, activity: turnActivity });
  const [recordingPosition, setRecordingPosition] = useState<{
    sessionId: string;
    turnId: string | null;
  } | null>(null);
  const viewerOpen = recordingPosition !== null && recordingPosition.sessionId === sessionId;
  const selectedTest =
    recordingPosition && recordingPosition.sessionId === sessionId
      ? tests.find((test) => test.turnId === recordingPosition.turnId)
      : undefined;
  const recordingUrl =
    selectedTest && sessionId
      ? `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}/sessions/${encodeURIComponent(sessionId)}/tests/${encodeURIComponent(selectedTest.turnId)}/recording`
      : null;
  const recording: RecordingView | null =
    selectedTest &&
    selectedTest.status !== "running" &&
    selectedTest.recording.state === "available" &&
    recordingUrl
      ? {
          videoUrl: recordingUrl,
          downloadUrl: `${recordingUrl}?download=1`,
          title: selectedTest.objective ?? "App test",
          annotations: selectedTest.annotations,
          counts: selectedTest.counts,
        }
      : null;
  const narrow = useNarrowPanel();
  const details = useThreadDetails(`${ownerId ?? "guest"}:${projectId}`);
  const chatHidden = visiblePanel && (maximized || narrow);
  const selected = panels.layout.tabs.find(
    (tab) => tab.kind === "file" && `file:${tab.path}` === panels.layout.active,
  );

  return (
    <div className="t3-workspace relative flex h-dvh flex-col overflow-hidden bg-surface">
      <main
        ref={containerRef}
        className="t3-workspace-panes relative grid min-h-0 flex-1 overflow-hidden"
        data-panel-open={visiblePanel}
        data-maximized={maximized && visiblePanel}
        style={paneStyle}
      >
        <div
          ref={details.ref}
          className="t3-chat-column min-h-0 min-w-0"
          hidden={chatHidden}
          data-details-card={details.open ? details.presentation : undefined}
        >
          <WorkspaceHeader
            projectName={headerNote(status, project?.name)}
            {...(status === "ready" && project !== undefined ? { onRename: rename } : {})}
            job={log.jobs.summary}
            panelOpen={visiblePanel}
            onTogglePanel={panels.toggle}
            detailsOpen={details.open}
            detailsId={details.id}
            detailsPresentation={details.presentation}
            onToggleDetails={details.toggle}
          />
          <ComputerNavigation.Provider value={openComputer}>
            <RecordingNavigation.Provider
              value={(turnId) => {
                if (sessionId) setRecordingPosition({ sessionId, turnId });
              }}
            >
              <LiveChatPane
                ownerId={ownerId}
                active={!chatHidden}
                sessionId={sessionId}
                projectId={projectId}
                log={log}
                onActivity={setTurnActivity}
                files={files.listing?.files}
                onOpenFile={openFile}
                onOpenChanges={() => panels.open({ kind: "diff" })}
                {...(fetchJson === undefined ? {} : { fetchJson })}
              />
            </RecordingNavigation.Provider>
          </ComputerNavigation.Provider>
          {details.open && status === "ready" && (
            <ThreadDetailsPanel
              key={projectId}
              id={details.id}
              projectId={projectId}
              sessionId={sessionId}
              phase={phase}
              previewUrl={previewUrl}
              revision={githubRevision}
              replayed={log.replayed}
              sandboxId={project?.sandboxId}
              presentation={details.presentation}
              onDismiss={details.dismiss}
              onOpenChanges={() => panels.open({ kind: "diff" })}
              onOpenPullRequests={() => panels.open({ kind: "pr" })}
              onOpenRecordings={() => {
                if (sessionId)
                  setRecordingPosition({
                    sessionId,
                    turnId:
                      tests.findLast(
                        (test) => test.status !== "running" && test.recording.state === "available",
                      )?.turnId ?? null,
                  });
              }}
              fetchJson={fetchJson}
            />
          )}
        </div>
        {visiblePanel && !maximized && (
          <div className="t3-panel-divider">
            <Splitter
              label="Right panel width"
              value={width}
              onGrab={onGrab}
              onKeyDown={onKeyDown}
              quiet
            />
          </div>
        )}
        {visiblePanel && (
          <button
            type="button"
            className="t3-panel-backdrop"
            tabIndex={-1}
            aria-label="Dismiss right panel"
            onClick={panels.hide}
          />
        )}
        <Workbench
          job={log.jobs.summary}
          chatHidden={chatHidden}
          narrow={narrow}
          controller={panels}
          maximized={maximized}
          onMaximize={() => setMaximized((value) => !value)}
          computer={
            <ComputerPane
              events={log.events}
              selectedSeq={computerSeq}
              onSeek={seekComputer}
              sessionId={sessionId}
              sandboxId={project?.sandboxId ?? undefined}
              projectId={projectId}
              active={
                visiblePanel && panels.layout.active === "computer" && phase.kind === "running"
              }
              fetchJson={fetchJson}
              busy={computerBusy}
              eventStreamReady={log.replayed && log.status === "open"}
            />
          }
          preview={
            <>
              <BrowserToolbar
                route={route}
                previewUrl={previewUrl}
                onRouteChange={setRoute}
                onReload={() => setReloads((count) => count + 1)}
              />
              <PreviewPane
                phase={phase}
                previewRequired={previewRequired}
                route={route}
                reloads={reloads}
                onResume={() => void resume()}
                {...(resumeError === undefined ? {} : { resumeError })}
              />
            </>
          }
          code={
            <FileTreePane
              listing={files.listing}
              status={files.status}
              putAway={phase.kind === "put-away"}
              changed={log.changed}
              selected={selected?.kind === "file" ? selected.path : undefined}
              onSelect={openFile}
            />
          }
          diff={
            <ChangesPanel
              sessionId={sessionId}
              baseBranch={repository?.baseBranch}
              revision={githubRevision}
              active={visiblePanel && panels.layout.active === "diff"}
              onOpenFile={openFile}
              fetchJson={fetchJson}
            />
          }
          pullRequests={
            status === "ready" ? (
              <ProjectGitHubControl
                key={projectId}
                projectId={projectId}
                presentation="panel"
                active={visiblePanel && panels.layout.active === "pr"}
                refreshKey={githubRevision}
                onRepository={receiveRepository}
                {...(fetchJson === undefined ? {} : { fetchJson })}
              />
            ) : (
              <div className="t3-panel-empty">Open a project to view pull requests.</div>
            )
          }
          file={(path) => (
            <FilePanel sessionId={sessionId} path={path} log={log} fetchJson={fetchJson} />
          )}
        />
      </main>
      {viewerOpen && (
        <RecordingViewer recording={recording} onClose={() => setRecordingPosition(null)} />
      )}
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
