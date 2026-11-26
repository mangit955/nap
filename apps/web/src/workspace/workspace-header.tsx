"use client";

import { PanelRight } from "lucide-react";
import { PhaseDot } from "../chat/job-marks.tsx";
import type { JobSummary } from "../chat/job-summary.ts";
import { EditableTitle } from "../ui/editable-title.tsx";
import { Tooltip } from "../ui/tooltip.tsx";
import { type DetailsPresentation, ThreadDetailsToggle } from "./thread-details.tsx";

export function WorkspaceHeader({
  projectName,
  onRename,
  job,
  panelOpen,
  onTogglePanel,
  detailsOpen = false,
  detailsId,
  detailsPresentation,
  onToggleDetails,
}: {
  projectName: string;
  onRename?: ((name: string) => Promise<string | undefined>) | undefined;
  job: JobSummary | null;
  panelOpen: boolean;
  onTogglePanel: () => void;
  detailsOpen?: boolean;
  detailsId?: string;
  detailsPresentation?: DetailsPresentation;
  onToggleDetails?: (() => void) | undefined;
}) {
  return (
    <header className="workspace-header t3-chat-header">
      {onRename ? (
        <EditableTitle
          name={projectName}
          onRename={onRename}
          className="truncate text-sm"
          inputClassName="text-sm w-44"
        />
      ) : (
        <span className="truncate text-sm">{projectName}</span>
      )}
      <p
        role="status"
        aria-label="Job phase"
        className="ml-auto flex min-w-0 items-center gap-1.5 text-[11px] text-muted"
      >
        {job && (
          <>
            <PhaseDot job={job} />
            <span className="truncate">{job.phaseLabel}</span>
          </>
        )}
      </p>
      {/* Only where there are thread details to open: a button that opens nothing is worse than none. */}
      {onToggleDetails && (
        <ThreadDetailsToggle
          open={detailsOpen}
          controls={detailsId}
          presentation={detailsPresentation}
          onToggle={onToggleDetails}
        />
      )}
      {/* Drawn by the app, as its neighbour the details toggle is, rather than by the browser. */}
      <Tooltip label={panelOpen ? "Hide right panel" : "Show right panel"} side="left">
        <button
          type="button"
          className="t3-icon-button"
          aria-label={panelOpen ? "Hide right panel" : "Show right panel"}
          onClick={onTogglePanel}
        >
          <PanelRight />
        </button>
      </Tooltip>
    </header>
  );
}
