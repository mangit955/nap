"use client";

/**
 * One project, as a card.
 *
 * The tile above the name stands where a screenshot would, and is deliberately not one: a live
 * preview would boot the sandbox it claims to be showing — which costs money and takes a minute
 * — and a stored thumbnail would be a picture of an app as it was some other day. What it is
 * instead is a colour hashed from the project's id, so the grid is at least a map.
 *
 * **State is a word, never a colour.** "running", "put away", "new" — the same rule the chat
 * pane and the old list followed, for the same reason: a dot tells a screen reader nothing and
 * tells anybody who cannot separate two hues the wrong thing.
 *
 * Deleting asks first. It is the one action here that cannot be undone — the bytes go with the
 * row, and there is no snapshot left to open afterwards.
 */

import { type ProjectSummaryPayload, projectState } from "@nap/shared/projects-protocol";
import { useState } from "react";
import { EditableTitle } from "../ui/editable-title.tsx";
import { tileGradient } from "./filters.ts";
import { relativeTime } from "./relative-time.ts";

export function ProjectCard({
  project,
  busy = false,
  onOpen,
  onClose,
  onDelete,
  onRename,
}: {
  project: ProjectSummaryPayload;
  /** Set while an action is in flight, so a card's buttons cannot be pressed twice. */
  busy?: boolean;
  onOpen: (projectId: string) => void;
  onClose: (projectId: string) => void;
  onDelete: (projectId: string) => void;
  /** Optional so the render tests that are about the other actions need not supply one. */
  onRename?: ((projectId: string, name: string) => void) | undefined;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="flex flex-col overflow-hidden rounded-xl border border-edge bg-panel transition-colors hover:border-line-strong">
      <button
        type="button"
        onClick={() => onOpen(project.projectId)}
        className="group flex flex-col text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        <span
          aria-hidden="true"
          className="h-28 w-full border-edge border-b"
          style={{ background: tileGradient(project.projectId) }}
        />
        {/*
          The name used to be inside this button and is now the editable control below it, which
          left the button with nothing but a coloured rectangle in it — no accessible name at all,
          and unreachable for anybody not using a mouse. It says what it does instead of what it
          is: "Open" is the action, and the name identifies which project it opens.
        */}
        <span className="sr-only">Open {project.name}</span>
      </button>

      {/*
        Outside the open button rather than inside it. Nesting an editable name in a button that
        opens the project would make every click on the name a navigation — and the whole point
        of the control is that clicking the name edits it.
      */}
      <div className="px-2 pt-2.5">
        {onRename === undefined ? (
          <span className="block truncate px-1.5 font-medium text-ink text-sm">{project.name}</span>
        ) : (
          <EditableTitle
            name={project.name}
            onRename={(name) => {
              onRename(project.projectId, name);
              return undefined;
            }}
            className="w-full font-medium text-ink text-sm"
            inputClassName="w-full text-sm font-medium"
          />
        )}
      </div>

      <div className="flex items-center justify-between gap-2 px-3.5 pt-1.5 pb-3">
        <p className="font-mono text-[11px] text-muted">
          {projectState(project)} · {relativeTime(project.updatedAt)}
        </p>

        <div className="flex shrink-0 items-center gap-2 font-mono text-[11px]">
          {project.sandboxId !== null && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onClose(project.projectId)}
              className="text-muted hover:text-ink disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              Close
            </button>
          )}

          {confirming ? (
            <span className="flex items-center gap-2">
              <span className="text-muted">For good?</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  onDelete(project.projectId);
                }}
                className="text-danger hover:underline disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
              >
                Yes, delete
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="text-muted hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(true)}
              className="text-muted hover:text-danger disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
