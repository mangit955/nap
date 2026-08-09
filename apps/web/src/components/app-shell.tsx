"use client";

import { useSession } from "../session/use-session.ts";
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
 * **The session is resolved once, here, and passed down.** Each pane subscribes to the same
 * session independently — four panes calling `useSession` would be four calls to create one,
 * and four projects nobody asked for.
 */
export function AppShell() {
  const { sessionId, status } = useSession();

  return (
    <div className="flex h-dvh flex-col bg-surface">
      <header className="flex h-12 shrink-0 items-center justify-between border-edge border-b px-4">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-ink text-sm tracking-tight">nap</span>
          <span className="text-muted text-xs">
            {status === "error" ? "could not reach the server" : "untitled project"}
          </span>
        </div>
        <LiveConnectionStatus sessionId={sessionId} />
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[360px_1fr_260px] gap-px bg-edge">
        <LiveChatPane sessionId={sessionId} />
        <LivePreviewPane sessionId={sessionId} />
        <LiveFileTreePane sessionId={sessionId} />
      </main>
    </div>
  );
}
