"use client";

/**
 * The Code half of the workbench: the project's files, and whichever one is open.
 *
 * Side by side rather than one over the other. The tree used to be a permanent column with the
 * viewer sliding over it as a dialog, which meant opening a file hid the list you were reading
 * it against. Now the tab owns the whole right of the window and there is room for both.
 *
 * It subscribes to the same session stream the other panes do — the tree marks what this session
 * changed, and a file's contents are re-read when the sandbox that serves them appears.
 */

import { useState } from "react";
import { FileTreePane } from "../components/file-tree-pane.tsx";
import { changedPaths } from "../files/changed-paths.ts";
import { FileViewer } from "../files/file-viewer.tsx";
import { useFileContent, useProjectFiles } from "../files/use-project-files.ts";
import { useEventStream } from "../hooks/use-event-stream.ts";
import { isPutAway } from "../preview/preview-state.ts";
import { FileIcon } from "../ui/icons.tsx";
import { Splitter } from "../ui/splitter.tsx";
import { TREE_SPLIT } from "./split.ts";
import { usePaneWidth } from "./use-pane-width.ts";

export function LiveCodePane({
  sessionId,
  putAwayAt,
  resuming,
}: {
  sessionId: string | undefined;
  /** When the record last said no sandbox was serving this project; see `isPutAway`. */
  putAwayAt?: string | undefined;
  resuming?: boolean | undefined;
}) {
  const { events } = useEventStream({ sessionId });
  // The same question the preview asks, answered by the same function rather than by a second
  // rule here — two panes disagreeing about whether a project is running is precisely the
  // confusion this pane's copy is trying to resolve.
  const putAway = isPutAway(events, putAwayAt) && resuming !== true;
  const { listing, status } = useProjectFiles({ sessionId, events });
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const { file, status: fileStatus } = useFileContent({ sessionId, path: selected });
  const { width, containerRef, onGrab, onKeyDown } = usePaneWidth(TREE_SPLIT, 240);

  return (
    <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1">
      <div style={{ width: `${width}px` }} className="min-h-0 shrink-0 border-edge border-r">
        <FileTreePane
          listing={listing}
          status={status}
          putAway={putAway}
          changed={changedPaths(events)}
          selected={selected}
          onSelect={setSelected}
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
