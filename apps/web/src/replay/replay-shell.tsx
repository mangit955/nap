"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { jobView } from "../chat/job-summary.ts";
import { inFlightTurn } from "../chat/working-state.ts";
import { ChatPane } from "../components/chat-pane.tsx";
import { FileTreePane } from "../components/file-tree-pane.tsx";
import { PreviewPane } from "../components/preview-pane.tsx";
import { changedPaths } from "../files/changed-paths.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import type { SessionLog } from "../hooks/use-session-log.ts";
import { previewState } from "../preview/preview-state.ts";
import { BrowserToolbar } from "../workspace/browser-toolbar.tsx";
import { FilePanel } from "../workspace/file-panel.tsx";
import { useNarrowPanel } from "../workspace/use-narrow-panel.ts";
import { type PanelController, usePanelLayout } from "../workspace/use-panel-layout.ts";
import { Workbench } from "../workspace/workbench.tsx";
import { WorkspaceHeader } from "../workspace/workspace-header.tsx";
import { WorkspacePanes } from "../workspace/workspace-panes.tsx";
import { buildAt, filesAt, listingAt, withStandInPreviews } from "./playback.ts";
import type { ReplayRecording } from "./recording.ts";
import { ReplayBar } from "./replay-bar.tsx";
import { usePlayback } from "./use-playback.ts";

/**
 * A recorded session, played back in the workspace's own panes.
 *
 * The same frame, chat pane, header, workbench, file tree, file viewer and preview pane a live
 * project draws, fed from a recording instead of a socket. `AppShell` is not reused whole because
 * almost everything it adds is a way out of the page — the project record, the resume, the GitHub
 * controls, the desktop stream, the session's activity poll — and a replay must have none: it is
 * free to watch because it asks nothing of the API, which `replay-shell.test.tsx` holds it to by
 * failing on any request at all.
 *
 * **What stands in for the preview** is the app's own source at that point in the session, built
 * to static files this deployment serves (`ReplayRecording.builds`). The sandbox that served it
 * is gone, so its address answers nothing; a screenshot would show the app without letting
 * anybody use it. The build is the code the agent wrote, so what a visitor clicks is what the
 * session made.
 *
 * The preview pane frames it with the sandbox attributes it gives every app, `allow-same-origin`
 * included, and here that origin is this deployment's own rather than a sandbox's. Accepted
 * because a build is committed and reviewed like any page this site serves, and the app needs its
 * storage — the recorded reading list saves to `localStorage` without a guard, so a frame without
 * an origin of its own would throw on the first article saved.
 */
export function ReplayShell({ recording }: { recording: ReplayRecording }) {
  const playback = usePlayback(recording.events);
  const { events } = playback;
  const seq = events.at(-1)?.seq ?? 0;

  const [origin, setOrigin] = useState<string | undefined>(undefined);
  useEffect(() => setOrigin(window.location.origin), []);
  const shown = useMemo(
    () => (origin === undefined ? events : withStandInPreviews(recording, events, origin)),
    [events, recording, origin],
  );
  const changed = useMemo(() => changedPaths(shown), [shown]);
  const jobs = useMemo(() => jobView(shown), [shown]);
  // The panes that read a whole log take this shape; the socket's fields say it has all arrived.
  const log: SessionLog = useMemo(
    () => ({
      events: shown,
      status: "open",
      lastSeq: seq,
      replayed: true,
      preview: previewState(shown),
      changed,
      jobs,
    }),
    [shown, seq, changed, jobs],
  );
  const running =
    playback.state !== "ended" &&
    (inFlightTurn(shown) !== undefined || jobs.summary?.open === true);

  const build = buildAt(recording, seq);
  // A file read answers from the recording at the point playback has reached. Anything else this
  // page asked for would be a request to the API, so it fails rather than being sent.
  const files = useRef(filesAt(recording, seq));
  files.current = filesAt(recording, seq);
  const readFile: FetchJson = useMemo(
    () => async (url) => {
      const path = new URL(url).searchParams.get("path");
      const contents = path === null ? undefined : files.current.get(path);
      if (path === null || contents === undefined || !url.includes("/file?"))
        throw new Error(`A replay reads nothing over the network: ${url}`);
      return Response.json({
        path,
        contents,
        truncated: false,
        bytes: new TextEncoder().encode(contents).length,
      });
    },
    [],
  );

  const panels = usePanelLayout(`replay:${recording.slug}`);
  const narrow = useNarrowPanel();
  const [maximized, setMaximized] = useState(false);
  const [route, setRoute] = useState("/");
  const [reloads, setReloads] = useState(0);

  // The panel follows the session until the visitor takes it over: the file the agent is writing
  // while it writes, and the app once the turn is done. Only beside the conversation — on a phone
  // the panel covers it, and opening it unasked would hide what is being played. Everything the
  // visitor can do to the panel goes through `visitorPanels`, so any of it ends the following.
  const followed = useRef(true);
  const follow = useRef(panels);
  follow.current = panels;
  const visitorPanels = byVisitor(panels, () => {
    followed.current = false;
  });
  const lastRevision = recording.revisions.findLast((revision) => revision.seq <= seq);
  const turnEnded = shown.some((event) => event.type === "turn.completed");
  useEffect(() => {
    if (narrow || !followed.current) return;
    if (turnEnded) follow.current.open({ kind: "preview" });
    else if (lastRevision) follow.current.open({ kind: "file", path: lastRevision.path });
  }, [narrow, turnEnded, lastRevision]);

  const visiblePanel = panels.layout.open;
  const chatHidden = visiblePanel && (maximized || narrow);
  const openFile = (path: string) => visitorPanels.open({ kind: "file", path });
  const previewUrl = build && origin ? `${origin}${build.path}` : undefined;
  const appOnScreen = visiblePanel && !narrow && panels.layout.active === "preview";
  const empty = (text: string) => <div className="t3-panel-empty">{text}</div>;

  return (
    <WorkspacePanes
      panelOpen={visiblePanel}
      maximized={maximized}
      chatHidden={chatHidden}
      onDismissPanel={visitorPanels.hide}
      chat={
        <>
          <WorkspaceHeader
            projectName={`${recording.title} · replay`}
            job={jobs.summary}
            panelOpen={visiblePanel}
            onTogglePanel={visitorPanels.toggle}
          />
          <ChatPane
            events={shown}
            running={running}
            files={listingAt(recording, seq).files}
            onOpenFile={openFile}
            offerAppTest={false}
            composer={
              <ReplayBar
                recordedAt={recording.recordedAt}
                model={recording.model}
                state={playback.state}
                onPause={playback.pause}
                onResume={playback.resume}
                onRestart={playback.restart}
                onSkip={playback.skipToEnd}
                onOpenApp={
                  appOnScreen || build === undefined
                    ? undefined
                    : () => visitorPanels.open({ kind: "preview" })
                }
              />
            }
          />
        </>
      }
      workbench={
        <Workbench
          job={jobs.summary}
          chatHidden={chatHidden}
          narrow={narrow}
          controller={visitorPanels}
          maximized={maximized}
          onMaximize={() => setMaximized((value) => !value)}
          computer={undefined}
          preview={
            <>
              <BrowserToolbar
                route={route}
                previewUrl={previewUrl}
                onRouteChange={setRoute}
                onReload={() => setReloads((count) => count + 1)}
              />
              <PreviewPane
                phase={
                  build && previewUrl
                    ? { kind: "running", url: previewUrl, seq: build.fromSeq }
                    : { kind: "starting" }
                }
                previewRequired
                projectId={recording.slug}
                route={route}
                reloads={reloads}
              />
            </>
          }
          code={
            <FileTreePane
              listing={build ? listingAt(recording, seq) : undefined}
              status={build ? "ready" : "idle"}
              changed={changed}
              selected={undefined}
              onSelect={openFile}
            />
          }
          diff={empty(
            "In a replay, each change is in the conversation, beside the step that made it.",
          )}
          pullRequests={empty("This session opened no pull request.")}
          file={(path) => (
            <FilePanel sessionId={recording.slug} path={path} log={log} fetchJson={readFile} />
          )}
        />
      }
    />
  );
}

/** The same panel, with `onUse` called before anything the visitor does to it. */
function byVisitor(panels: PanelController, onUse: () => void): PanelController {
  const used =
    <Args extends unknown[]>(action: (...args: Args) => void) =>
    (...args: Args) => {
      onUse();
      action(...args);
    };
  return {
    layout: panels.layout,
    open: used(panels.open),
    select: used(panels.select),
    close: used(panels.close),
    toggle: used(panels.toggle),
    hide: used(panels.hide),
    closeOthers: used(panels.closeOthers),
    closeAll: used(panels.closeAll),
    move: used(panels.move),
  };
}
