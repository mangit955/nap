"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChangedFilesCard } from "../chat/changed-files-card.tsx";
import { type JobSummary, jobView } from "../chat/job-summary.ts";
import { ChatPane } from "../components/chat-pane.tsx";
import { FileTreePane } from "../components/file-tree-pane.tsx";
import { PreviewPane } from "../components/preview-pane.tsx";
import { Dashboard } from "../dashboard/dashboard.tsx";
import { DashboardHero } from "../dashboard/dashboard-hero.tsx";
import { Sidebar } from "../dashboard/sidebar.tsx";
import type { SessionLog } from "../hooks/use-session-log.ts";
import { previewState } from "../preview/preview-state.ts";
import { BrowserToolbar } from "../workspace/browser-toolbar.tsx";
import { FilePanel } from "../workspace/file-panel.tsx";
import { usePanelLayout } from "../workspace/use-panel-layout.ts";
import { Workbench } from "../workspace/workbench.tsx";
import { WorkspaceHeader } from "../workspace/workspace-header.tsx";
import {
  fetchStoryFile,
  STORY_DEFAULT_MODEL,
  STORY_MODELS,
  storyEvents,
  storyListing,
  storyThread,
} from "./story-demo-data.ts";
import {
  STORY_THREAD_IDS,
  type StoryChapter,
  type StoryDemoMessage,
  StoryDemoMessageSchema,
  type StoryThreadId,
} from "./story-demo-protocol.ts";
import "./product-story.css";

const noAction = () => {};
const activity = { startedAt: undefined };

function notify(type: "ready" | "build" | "describe" | "interact") {
  window.parent.postMessage(
    { source: "nap-story-demo", type } satisfies StoryDemoMessage,
    window.location.origin,
  );
}

type ThreadRun = { prompt: string; submitted: string; chapter: StoryChapter };
type ThreadRuns = Record<StoryThreadId, ThreadRun>;
function initialRuns(threadId: StoryThreadId, chapter: StoryChapter): ThreadRuns {
  const run = (id: StoryThreadId): ThreadRun => ({
    prompt: storyThread(id).prompt,
    submitted: storyThread(id).prompt,
    chapter: id === threadId ? chapter : "ready",
  });
  return { finance: run("finance"), cabins: run("cabins"), launch: run("launch") };
}
export function LandingDesktopDemo({
  initialThread = "finance",
  initialChapter = "describe",
}: {
  initialThread?: StoryThreadId;
  initialChapter?: StoryChapter;
}) {
  const [activeThread, setActiveThread] = useState<StoryThreadId>(initialThread);
  const activeRef = useRef(activeThread);
  activeRef.current = activeThread;
  const [runs, setRuns] = useState<ThreadRuns>(() => initialRuns(initialThread, initialChapter));
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const [model, setModel] = useState(STORY_DEFAULT_MODEL);
  const [at] = useState(() => new Date().toISOString());
  const updateRun = (change: Partial<ThreadRun>) =>
    setRuns((current) => ({
      ...current,
      [activeRef.current]: { ...current[activeRef.current], ...change },
    }));
  const activate = (id: StoryThreadId) => {
    activeRef.current = id;
    setActiveThread(id);
    window.parent.postMessage(
      {
        source: "nap-story-demo",
        type: "thread-selected",
        threadId: id,
        chapter: runsRef.current[id].chapter,
      } satisfies StoryDemoMessage,
      window.location.origin,
    );
  };
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      const parsed = StoryDemoMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "stage")
        setRuns((current) => ({
          ...current,
          [activeRef.current]: { ...current[activeRef.current], chapter: message.chapter },
        }));
      if (message.type === "initialize") {
        activeRef.current = message.threadId;
        setActiveThread(message.threadId);
        setRuns((current) => ({
          ...current,
          [message.threadId]: { ...current[message.threadId], chapter: message.chapter },
        }));
      }
      if (message.type === "select-thread") {
        activeRef.current = message.threadId;
        setActiveThread(message.threadId);
        window.parent.postMessage(
          {
            source: "nap-story-demo",
            type: "thread-selected",
            threadId: message.threadId,
            chapter: runsRef.current[message.threadId].chapter,
          } satisfies StoryDemoMessage,
          window.location.origin,
        );
      }
    };
    window.addEventListener("message", receive);
    notify("ready");
    return () => window.removeEventListener("message", receive);
  }, []);
  const thread = storyThread(activeThread);
  const run = runs[activeThread];
  const describe = () => {
    updateRun({ chapter: "describe" });
    notify("describe");
  };
  const build = (text: string) => {
    updateRun({ submitted: text, chapter: "build" });
    notify("build");
  };
  return (
    <div
      data-demo-chapter={run.chapter}
      data-demo-thread={activeThread}
      onPointerDownCapture={() => notify("interact")}
      onKeyDownCapture={() => notify("interact")}
    >
      <Dashboard
        persistSidebar={false}
        sidebar={({ closeNavigation }) => (
          <Sidebar
            persistScroll={false}
            name="You"
            email={undefined}
            recents={STORY_THREAD_IDS.map((id) => storyThread(id).project)}
            activeProjectId={run.chapter === "describe" ? undefined : thread.project.projectId}
            keyHint={undefined}
            onNewProject={describe}
            onApiKey={noAction}
            onSignOut={noAction}
            onSelectProject={(projectId) => {
              const selected = STORY_THREAD_IDS.find(
                (id) => storyThread(id).project.projectId === projectId,
              );
              if (!selected) return;
              activate(selected);
              closeNavigation();
            }}
          />
        )}
        hero={
          <>
            <div className="h-full" hidden={run.chapter !== "describe"}>
              <DashboardHero
                autoFocus={false}
                value={run.prompt}
                onChange={(prompt) => updateRun({ prompt })}
                onSubmit={build}
                models={STORY_MODELS}
                model={model}
                onModelChange={setModel}
                onRepositories={noAction}
              />
            </div>
            <div className="h-full" hidden={run.chapter === "describe"}>
              <DemoSession
                activeThread={activeThread}
                runs={runs}
                at={at}
                model={model}
                onModelChange={setModel}
              />
            </div>
          </>
        }
      />
    </div>
  );
}

function DemoSession({
  activeThread,
  runs,
  at,
  model,
  onModelChange,
}: {
  activeThread: StoryThreadId;
  runs: ThreadRuns;
  at: string;
  model: string;
  onModelChange: (model: string) => void;
}) {
  const thread = storyThread(activeThread);
  const run = runs[activeThread];
  const chapter = run.chapter;
  const listing = useMemo(() => storyListing(thread), [thread]);
  const changed = useMemo(() => new Set(listing.files), [listing]);
  const panels = usePanelLayout("landing-desktop-example");
  const panelActions = useRef(panels);
  panelActions.current = panels;
  const [maximized, setMaximized] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [routes, setRoutes] = useState<Record<StoryThreadId, string>>({
    finance: "/",
    cabins: "/",
    launch: "/",
  });
  const [reloads, setReloads] = useState<Record<StoryThreadId, number>>({
    finance: 0,
    cabins: 0,
    launch: 0,
  });
  const [origin, setOrigin] = useState("");
  const ready = chapter === "ready";
  const events = useMemo(
    () => storyEvents(thread, run.submitted, at, ready),
    [thread, run.submitted, at, ready],
  );
  const log: SessionLog = {
    events,
    status: "open",
    lastSeq: events.at(-1)?.seq ?? 0,
    replayed: true,
    preview: previewState(events),
    changed,
    jobs: jobView(events),
  };
  const job: JobSummary = {
    phase: ready ? "verified" : "working",
    phaseLabel: ready ? "Verified" : "Working",
    open: !ready,
  };
  useEffect(() => {
    setOrigin(window.location.origin);
    const viewport = window.matchMedia("(max-width: 980px)");
    const update = () => setNarrow(viewport.matches);
    update();
    viewport.addEventListener("change", update);
    return () => viewport.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (chapter === "ready") panelActions.current.open({ kind: "preview" });
    else if (chapter === "build" && !narrow)
      panelActions.current.open({ kind: "file", path: "src/App.tsx" });
    else panelActions.current.hide();
  }, [chapter, narrow]);
  const openFile = (path: string) => panels.open({ kind: "file", path });
  const hidden = panels.layout.open && (maximized || narrow);
  const previewUrl = ready && origin ? `${origin}${thread.previewPath}` : undefined;
  return (
    <div className="t3-workspace relative flex h-dvh flex-col overflow-hidden bg-surface">
      <div
        className="t3-workspace-panes relative grid min-h-0 flex-1 overflow-hidden"
        data-panel-open={panels.layout.open}
        data-maximized={maximized && panels.layout.open}
      >
        <div className="t3-chat-column min-h-0 min-w-0" hidden={hidden}>
          <WorkspaceHeader
            projectName={thread.project.name}
            job={job}
            panelOpen={panels.layout.open}
            onTogglePanel={panels.toggle}
            detailsOpen={false}
            onToggleDetails={noAction}
          />
          <ChatPane
            key={activeThread}
            active={false}
            events={events}
            running={!ready}
            activity={activity}
            files={listing.files}
            models={STORY_MODELS}
            model={model}
            onModelChange={onModelChange}
            onOpenFile={openFile}
            onOpenChanges={() => panels.open({ kind: "diff" })}
            onSubmit={noAction}
            onCancel={noAction}
          />
        </div>
        {panels.layout.open && !hidden && <div className="t3-panel-divider" />}
        <Workbench
          controller={panels}
          computer={undefined}
          job={job}
          chatHidden={hidden}
          narrow={narrow}
          modal={false}
          maximized={maximized}
          onMaximize={() => setMaximized((value) => !value)}
          preview={
            <>
              <BrowserToolbar
                route={routes[activeThread]}
                previewUrl={previewUrl}
                onRouteChange={(route) =>
                  setRoutes((current) => ({ ...current, [activeThread]: route }))
                }
                onReload={() =>
                  setReloads((current) => ({
                    ...current,
                    [activeThread]: current[activeThread] + 1,
                  }))
                }
              />
              <div className="relative min-h-0 flex-1">
                {STORY_THREAD_IDS.map((id) => (
                  <div
                    key={id}
                    className="absolute inset-0"
                    hidden={id !== activeThread}
                    data-preview-thread={id}
                  >
                    <PreviewPane
                      paneId={`story-preview-${id}`}
                      phase={
                        runs[id].chapter === "ready" && origin
                          ? {
                              kind: "running",
                              url: `${origin}${storyThread(id).previewPath}`,
                              seq: 1,
                            }
                          : { kind: "starting" }
                      }
                      route={routes[id]}
                      reloads={reloads[id]}
                    />
                  </div>
                ))}
              </div>
            </>
          }
          code={
            <FileTreePane
              listing={listing}
              status="ready"
              changed={changed}
              selected={undefined}
              onSelect={openFile}
            />
          }
          file={(path) => (
            <FilePanel
              key={thread.project.sessionIds[0]}
              sessionId={thread.project.sessionIds[0]}
              path={path}
              log={log}
              fetchJson={fetchStoryFile}
            />
          )}
          diff={
            <ChangedFilesCard
              files={[
                {
                  path: "src/App.tsx",
                  changeType: "created",
                  diff: "+export default function App() {\n+  return <Dashboard />;\n+}",
                  added: 3,
                  removed: 0,
                },
              ]}
            />
          }
          pullRequests={<div className="t3-panel-empty">No pull requests for this example.</div>}
        />
      </div>
    </div>
  );
}
