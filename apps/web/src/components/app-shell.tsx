"use client";

import type { ProjectRepository } from "@nap/shared/github-protocol";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { FileDiff, Files, Globe } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { TurnActivity } from "../chat/use-turn-submission.ts";
import { foldAppTests } from "../computer/app-test-state.ts";
import { computerIsBusy } from "../computer/computer-activity.ts";
import { ComputerPane } from "../computer/computer-pane.tsx";
import { ComputerNavigation } from "../computer/navigation.tsx";
import { RecordingNavigation } from "../computer/recording-navigation.tsx";
import { type RecordingView, RecordingViewer } from "../computer/recording-viewer.tsx";
import { thumbnailUrl } from "../dashboard/thumbnail-url.ts";
import { type FetchJson, useProjectFiles } from "../files/use-project-files.ts";
import { ProjectGitHubControl } from "../github/project-github.tsx";
import { useAfterReplay } from "../hooks/after-replay.ts";
import { forgetLog } from "../hooks/remembered-logs.ts";
import type { CreateSocket } from "../hooks/use-event-stream.ts";
import { useSessionLog } from "../hooks/use-session-log.ts";
import { useCommands } from "../palette/registry.ts";
import { phaseOf, recordState } from "../projects/project-phase.ts";
import { type OpenProject, useProject } from "../projects/use-projects.ts";
import { announceSessionsChanged } from "../projects/use-session-navigation.ts";
import { BrowserToolbar } from "../workspace/browser-toolbar.tsx";
import { ChangesPanel } from "../workspace/changes-panel.tsx";
import { FilePanel } from "../workspace/file-panel.tsx";
import { ThreadDetailsPanel, useThreadDetails } from "../workspace/thread-details.tsx";
import { useNarrowPanel } from "../workspace/use-narrow-panel.ts";
import { usePanelLayout } from "../workspace/use-panel-layout.ts";
import { Workbench } from "../workspace/workbench.tsx";
import { WorkspaceHeader } from "../workspace/workspace-header.tsx";
import { WorkspacePanes } from "../workspace/workspace-panes.tsx";
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

  const {
    project,
    sessionId,
    name,
    known,
    status,
    putAwayAt,
    resume,
    resuming,
    resumeError,
    rename,
  } = useProject(projectId, {
    previewSeq,
    previewRequired,
    refreshKey: projectRefreshKey,
    ...(fetchJson === undefined ? {} : { fetchJson }),
  });

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

  // Opening a put-away project starts nothing: the panes show its last snapshot and its chat, and
  // a message or the Resume button is what brings it up. A start on arrival took one of the
  // person's sandbox slots for every project they merely looked at (ADR-0037).

  // What this tab last saw of the project is drawn while its log replays, but only for the person
  // who saw it, and never for a project the server says is gone: there it would stay on screen
  // under "this project no longer exists", since no session ever arrives to replace it.
  const missing = status === "missing";
  useEffect(() => {
    if (missing) forgetLog(projectId);
  }, [missing, projectId]);
  const log = useSessionLog({
    sessionId,
    remember: ownerId === undefined || missing ? undefined : { ownerId, projectId },
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
    previewRequired,
  });

  // The restore's own end condition, reported to the hook that is waiting for it. In an effect
  // rather than during render because it feeds a hook that has already run this frame.
  const announced = log.preview.status === "ready" ? log.preview.seq : undefined;
  useEffect(() => {
    setPreviewSeq(announced);
  }, [announced]);

  const previewUrl = phase.kind === "running" ? phase.url : undefined;
  const githubRevision = useAfterReplay(log.events, changesGitHub, log.replayed, sessionId);
  const projectRevision = useAfterReplay(log.events, changesRecord, log.replayed, sessionId);
  useEffect(() => {
    setProjectRefreshKey(projectRevision);
  }, [projectRevision]);
  // Something the sidebar's card shows changed in this session — a turn started or ended, or a
  // model titled it — so every list is told to read again now rather than at its next poll. The
  // card is never drawn from the event, which a replay could make stale. Only what arrives after
  // the replay counts: the history was already in the list each of them read when it loaded.
  const cardSeq = log.events.findLast(
    (event) =>
      event.type === "project.renamed" ||
      event.type === "turn.started" ||
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "job.completed",
  )?.seq;
  const announcedCardSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!log.replayed) {
      announcedCardSeq.current = undefined;
      return;
    }
    const seen = announcedCardSeq.current;
    announcedCardSeq.current = cardSeq ?? 0;
    if (seen !== undefined && cardSeq !== undefined && cardSeq > seen) announceSessionsChanged();
  }, [log.replayed, cardSeq]);

  const files = useProjectFiles({
    sessionId,
    events: log.events,
    replayed: log.replayed,
    ...(fetchJson === undefined ? {} : { fetchJson }),
  });

  const panels = usePanelLayout(`${ownerId ?? "guest"}:${projectId}:${sessionId ?? "pending"}`, {
    takesHandOver: true,
  });
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
  useCommands(() => [
    {
      id: "open-files",
      group: "Actions",
      order: 2,
      label: "Open Files",
      icon: <Files className="size-4" aria-hidden />,
      run: () => panels.open({ kind: "code" }),
    },
    {
      id: "open-browser",
      group: "Actions",
      order: 3,
      label: "Open Browser",
      icon: <Globe className="size-4" aria-hidden />,
      run: () => panels.open({ kind: "preview" }),
    },
    {
      id: "show-changes",
      group: "Actions",
      order: 4,
      label: "Show changed files",
      icon: <FileDiff className="size-4" aria-hidden />,
      run: () => panels.open({ kind: "diff" }),
    },
  ]);
  const visiblePanel = panels.layout.open;
  const tests = useMemo(() => foldAppTests(log.events), [log.events]);
  const [turnActivity, setTurnActivity] = useState<TurnActivity | null>(null);
  const computerBusy = useMemo(
    () => computerIsBusy({ sessionId, events: log.events, activity: turnActivity }),
    [sessionId, log.events, turnActivity],
  );
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
          title: selectedTest.goal ?? "App test",
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
    <WorkspacePanes
      panelOpen={visiblePanel}
      maximized={maximized}
      chatHidden={chatHidden}
      onDismissPanel={panels.hide}
      chatRef={details.ref}
      detailsCard={details.open ? details.presentation : undefined}
      chat={
        <>
          <WorkspaceHeader
            projectName={headerNote(status, name)}
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
        </>
      }
      workbench={
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
                projectId={projectId}
                // The dashboard's picture, from the same route and at the same version. Only from a
                // record that is this project's, so a stale one can never lend its picture to B.
                {...(project?.projectId === projectId
                  ? { thumbnail: { projectId, src: thumbnailUrl(projectId, project.updatedAt) } }
                  : {})}
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
            // Read by project, so a project the tab already knows asks at the click: its answer
            // also says whether the preview is required, which the panes wait on.
            known ? (
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
      }
      overlay={
        viewerOpen && (
          <RecordingViewer recording={recording} onClose={() => setRecordingPosition(null)} />
        )
      }
    />
  );
}

/** Events after which the project's GitHub state is worth reading again. */
const changesGitHub = (event: StoredEvent) =>
  event.type === "system.notice" ||
  event.type === "preview.ready" ||
  event.type === "preview.stopped" ||
  event.type === "turn.completed" ||
  event.type === "turn.failed" ||
  event.type === "verification.completed";

/** Events after which the project's record — its sandbox, its name — is worth reading again. */
const changesRecord = (event: StoredEvent) =>
  event.type === "system.notice" ||
  event.type === "preview.stopped" ||
  event.type === "project.renamed";

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
      // A name the tab already knew is drawn at once; the record confirms it a round trip later.
      return name ?? "opening…";
    case "missing":
      return "this project no longer exists";
    case "error":
      return "could not reach the server";
    default:
      return name ?? "untitled project";
  }
}
