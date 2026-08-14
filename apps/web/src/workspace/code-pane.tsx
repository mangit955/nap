"use client";

/**
 * The Code half of the workbench: the project's files, and whichever one is open.
 *
 * Side by side rather than one over the other. The tree used to be a permanent column with the
 * viewer sliding over it as a dialog, which meant opening a file hid the list you were reading
 * it against. Now the tab owns the whole right of the window and there is room for both.
 *
 * It reads the workspace's session log rather than subscribing for itself — the tree marks what
 * this session changed, and a file's contents are re-read when the sandbox that serves them
 * appears.
 */

import { useEffect, useState } from "react";
import { FileTreePane } from "../components/file-tree-pane.tsx";
import { FileViewer } from "../files/file-viewer.tsx";
import { type FetchJson, type ProjectFiles, useFileContent } from "../files/use-project-files.ts";
import type { SessionLog } from "../hooks/use-session-log.ts";
import type { ProjectPhase } from "../projects/project-phase.ts";
import { FileIcon } from "../ui/icons.tsx";
import { Splitter } from "../ui/splitter.tsx";
import { TREE_SPLIT } from "./split.ts";
import { usePaneWidth } from "./use-pane-width.ts";

/**
 * How much of a project to read ahead when somebody opens the Code tab.
 *
 * A generated project is a dozen files, so this covers all of it — while a listing that came
 * back with its 500-entry limit must not turn one tab switch into 500 sandbox reads.
 */
const PREFETCH_LIMIT = 40;

export function LiveCodePane({
  sessionId,
  log,
  phase,
  files,
  fetchJson,
  active = true,
}: {
  sessionId: string | undefined;
  /**
   * Whether this tab is the one on screen. Both panels stay mounted and one is merely hidden,
   * so without this every workspace load would read forty files nobody is going to look at.
   */
  active?: boolean | undefined;
  /** The workspace's one subscription, resolved above. */
  log: SessionLog;
  /**
   * What the project is doing, decided above by `phaseOf` — the same answer the preview pane
   * draws, so the two cannot disagree about whether anything is serving this project.
   */
  phase: ProjectPhase;
  /** The project's listing, fetched once for the workspace. */
  files: ProjectFiles;
  fetchJson?: FetchJson | undefined;
}) {
  const { events, changed } = log;
  const { listing, status } = files;
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const {
    file,
    status: fileStatus,
    prefetch,
  } = useFileContent({
    sessionId,
    path: selected,
    events,
    ...(fetchJson === undefined ? {} : { fetchJson }),
  });

  // Once, when the tab is first shown and the listing is in. The hook skips anything already
  // cached, so a second run after a turn rewrites the project costs only what actually changed.
  const paths = listing?.files;
  useEffect(() => {
    if (!active || paths === undefined) return;
    prefetch(paths.slice(0, PREFETCH_LIMIT));
  }, [active, paths, prefetch]);
  const { width, containerRef, onGrab, onKeyDown } = usePaneWidth(TREE_SPLIT, 240);

  return (
    <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1">
      <div style={{ width: `${width}px` }} className="min-h-0 shrink-0 border-edge border-r">
        <FileTreePane
          listing={listing}
          status={status}
          putAway={phase.kind === "put-away"}
          changed={changed}
          selected={selected}
          onSelect={setSelected}
          onPrefetch={(path) => prefetch([path])}
        />
      </div>

      <Splitter label="File tree width" value={width} onGrab={onGrab} onKeyDown={onKeyDown} />

      {selected === undefined ? (
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <FileIcon className="size-6 text-edge" />
          <p className="text-[13px] text-ink-2">Pick a file to read it</p>
          <p className="max-w-[36ch] text-[12px] text-muted leading-relaxed">
            Everything the agent wrote is here, exactly as it left it. Files it touched this session
            are marked.
          </p>
        </div>
      ) : (
        <FileViewer
          path={selected}
          file={file}
          status={fileStatus}
          onClose={() => setSelected(undefined)}
        />
      )}
    </div>
  );
}
