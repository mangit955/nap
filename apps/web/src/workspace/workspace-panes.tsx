"use client";

import { type CSSProperties, type ReactNode, type Ref, useRef } from "react";
import { Splitter } from "../ui/splitter.tsx";
import { useDocumentScrollLock } from "../ui/use-document-scroll-lock.ts";
import { useSendGlide } from "./send-glide.ts";
import { PANEL_SPLIT } from "./split.ts";
import { usePaneWidth } from "./use-pane-width.ts";

/**
 * The workspace's frame: the conversation column, the divider that sizes the right panel, the
 * backdrop that dismisses it on a narrow screen, and the panel itself.
 *
 * Shared by everything that draws the workspace — a live project and a replay — so a layout fix
 * lands in both. What goes *in* the column and the panel is the caller's, because that is where
 * they differ: a live project wires its panes to the API, and a replay to a recording.
 */
export function WorkspacePanes({
  panelOpen,
  maximized,
  chatHidden,
  onDismissPanel,
  chat,
  chatRef,
  detailsCard,
  workbench,
  overlay,
}: {
  panelOpen: boolean;
  maximized: boolean;
  /** The conversation is covered by the panel — maximized, or on a narrow screen. */
  chatHidden: boolean;
  onDismissPanel: () => void;
  /** The conversation column's contents: its header, the chat, anything docked beside it. */
  chat: ReactNode;
  chatRef?: Ref<HTMLDivElement> | undefined;
  /** How the thread details card is presented in the column, if it is open. */
  detailsCard?: string | undefined;
  workbench: ReactNode;
  /** Drawn over the whole workspace, such as a recording viewer. */
  overlay?: ReactNode;
}) {
  const { width, containerRef, onGrab, onKeyDown } = usePaneWidth(PANEL_SPLIT, 540);
  useDocumentScrollLock();
  // A prompt sent from the dashboard arrives here; this frame plays its glide. See `send-glide.ts`.
  const frame = useRef<HTMLDivElement>(null);
  useSendGlide(frame);
  const paneStyle: CSSProperties & { "--panel-width": string } = { "--panel-width": `${width}px` };
  return (
    <div
      ref={frame}
      className="t3-workspace relative flex h-dvh flex-col overflow-hidden bg-surface"
    >
      <main
        ref={containerRef}
        className="t3-workspace-panes relative grid min-h-0 flex-1 overflow-hidden"
        data-panel-open={panelOpen}
        data-maximized={maximized}
        style={paneStyle}
      >
        <div
          ref={chatRef}
          className="t3-chat-column min-h-0 min-w-0"
          hidden={chatHidden}
          data-details-card={detailsCard}
        >
          {chat}
        </div>
        {panelOpen && !maximized && (
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
        {panelOpen && (
          <button
            type="button"
            className="t3-panel-backdrop"
            tabIndex={-1}
            aria-label="Dismiss right panel"
            onClick={onDismissPanel}
          />
        )}
        {workbench}
      </main>
      {overlay}
    </div>
  );
}
