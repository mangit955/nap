"use client";

import { useState } from "react";
import { ChatPane } from "../components/chat-pane.tsx";
import { PreviewPane } from "../components/preview-pane.tsx";
import { BrowserToolbar } from "./browser-toolbar.tsx";
import { useNarrowPanel } from "./use-narrow-panel.ts";
import { usePanelLayout } from "./use-panel-layout.ts";
import { Workbench } from "./workbench.tsx";
import type { StartingPrompt } from "./workspace-entry.ts";
import { WorkspaceHeader } from "./workspace-header.tsx";
import { WorkspacePanes } from "./workspace-panes.tsx";

const NOTHING_YET = <div className="t3-panel-empty">Your project is starting.</div>;

/**
 * The workspace of a project the server is still creating: the prompt that was sent, working,
 * in the frame the real workspace will draw a moment later — so that when the project's address
 * arrives and `AppShell` takes over, the same things stay where they are.
 *
 * Nothing here can act. There is no project to send to, stop or resume, so the composer is a
 * picture of a busy one rather than an input that would drop what was typed into it.
 */
export function StartingWorkspace({ prompt }: { prompt: StartingPrompt | null }) {
  const narrow = useNarrowPanel();
  // Its own scope: the project's layout is keyed by an id that does not exist yet.
  const panels = usePanelLayout("starting");
  const [maximized, setMaximized] = useState(false);
  // Never over the prompt on a narrow screen, where the panel covers the conversation: the prompt
  // is the one thing this page has to show, and the layout saved here is shared by every start.
  // There it opens only when asked, and the asking is not saved for the next start.
  const [narrowOpen, setNarrowOpen] = useState(false);
  const panelOpen = narrow ? narrowOpen : panels.layout.open;
  const controller = narrow
    ? {
        ...panels,
        layout: { ...panels.layout, open: narrowOpen },
        toggle: () => setNarrowOpen((open) => !open),
        hide: () => setNarrowOpen(false),
      }
    : panels;
  const chatHidden = panelOpen && (maximized || narrow);
  return (
    <WorkspacePanes
      panelOpen={panelOpen}
      maximized={maximized}
      chatHidden={chatHidden}
      onDismissPanel={controller.hide}
      chat={
        <>
          <WorkspaceHeader
            projectName="opening…"
            job={null}
            panelOpen={panelOpen}
            onTogglePanel={controller.toggle}
          />
          <ChatPane
            events={[]}
            loading={prompt === null}
            pending={prompt?.text}
            running={prompt !== null}
            offerAppTest={false}
            composer={
              <div className="chat-input relative mx-auto w-full max-w-[46rem] px-4 pt-2 pb-4">
                <div className="workspace-composer px-4 py-4 text-sm text-muted" role="status">
                  Starting your project…
                </div>
              </div>
            }
          />
        </>
      }
      workbench={
        <Workbench
          chatHidden={chatHidden}
          narrow={narrow}
          controller={controller}
          maximized={maximized}
          onMaximize={() => setMaximized((value) => !value)}
          preview={
            <>
              {/* Without a preview address its input is disabled and it offers no buttons. */}
              <BrowserToolbar
                route="/"
                previewUrl={undefined}
                onRouteChange={() => {}}
                onReload={() => {}}
              />
              <PreviewPane phase={{ kind: "starting" }} />
            </>
          }
          computer={NOTHING_YET}
          code={NOTHING_YET}
          diff={NOTHING_YET}
          pullRequests={NOTHING_YET}
          file={() => NOTHING_YET}
        />
      }
    />
  );
}
