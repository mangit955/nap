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

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="w-60 shrink-0 overflow-auto border-edge border-r">
        <FileTreePane
          listing={listing}
          status={status}
          putAway={putAway}
          changed={changedPaths(events)}
          selected={selected}
          onSelect={setSelected}
        />
      </div>

      {selected === undefined ? (
        <div className="grid min-w-0 flex-1 place-items-center p-6">
          <p className="text-muted text-sm">Pick a file to read it.</p>
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
