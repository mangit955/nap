import { ChatPane } from "./chat-pane.tsx";
import { FileTreePane } from "./file-tree-pane.tsx";
import { PreviewPane } from "./preview-pane.tsx";

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
 */
export function AppShell() {
  return (
    <div className="flex h-dvh flex-col bg-surface">
      <header className="flex h-12 shrink-0 items-center justify-between border-edge border-b px-4">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-ink text-sm tracking-tight">nap</span>
          <span className="text-muted text-xs">untitled project</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
          <span className="text-muted text-xs">ready</span>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[360px_1fr_260px] gap-px bg-edge">
        <ChatPane />
        <PreviewPane />
        <FileTreePane />
      </main>
    </div>
  );
}
