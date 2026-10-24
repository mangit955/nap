"use client";

import { PanelRight } from "lucide-react";
import { PhaseDot } from "../chat/job-marks.tsx";
import type { JobSummary } from "../chat/job-summary.ts";
import { EditableTitle } from "../ui/editable-title.tsx";
import { ThreadDetailsToggle } from "./thread-details.tsx";

export function WorkspaceHeader({
  projectName,
  onRename,
  job,
  panelOpen,
  onTogglePanel,
  detailsOpen,
  onToggleDetails,
}: {
  projectName: string;
  onRename?: ((name: string) => Promise<string | undefined>) | undefined;
  job: JobSummary | null;
  panelOpen: boolean;
  onTogglePanel: () => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
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
      <ThreadDetailsToggle open={detailsOpen} onToggle={onToggleDetails} />
      <button
        type="button"
        className="t3-icon-button"
        title={panelOpen ? "Hide right panel" : "Show right panel"}
        aria-label={panelOpen ? "Hide right panel" : "Show right panel"}
        onClick={onTogglePanel}
      >
        <PanelRight />
      </button>
    </header>
  );
}
