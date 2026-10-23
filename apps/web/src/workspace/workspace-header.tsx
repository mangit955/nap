"use client";

import { Info, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import { PhaseDot } from "../chat/job-marks.tsx";
import type { JobSummary } from "../chat/job-summary.ts";
import { EditableTitle } from "../ui/editable-title.tsx";

export function WorkspaceHeader({
  projectName,
  onRename,
  job,
  panelOpen,
  onTogglePanel,
  details,
}: {
  projectName: string;
  onRename?: ((name: string) => Promise<string | undefined>) | undefined;
  job: JobSummary | null;
  panelOpen: boolean;
  onTogglePanel: () => void;
  details?: ReactNode;
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
      <details className="t3-details">
        <summary aria-label="Thread details" title="Thread details" className="t3-icon-button">
          <Info />
        </summary>
        <div className="t3-details-card">
          <h2>{projectName}</h2>
          {details}
        </div>
      </details>
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
