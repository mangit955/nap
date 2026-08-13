"use client";

/**
 * One project, as a card.
 *
 * The tile above the name is a picture of the app itself, taken with a real browser at the end
 * of the last turn that changed it. Not a live preview: that would boot the sandbox it claims
 * to be showing, which costs money and takes a minute. So it *is* a picture of the app as it
 * was some other day — the trade this makes deliberately, because a grid of real apps is worth
 * far more than a grid of colours, and the day in question is the last one anybody worked on it.
 *
 * **The colour is still here, underneath.** A project has no picture until a turn completes
 * with a browser configured, so the gradient hashed from the project's id remains the tile's
 * background and the image sits on top of it. A request that 404s just leaves it showing — a
 * card must not sprout a broken-image icon because a screenshot was never taken.
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
import { TrashIcon } from "../ui/icons.tsx";
import { tileGradient } from "./filters.ts";
import { relativeTime } from "./relative-time.ts";
import { thumbnailUrl } from "./thumbnail-url.ts";

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
  /**
   * Set when the picture does not load, which is the ordinary case for a project that has never
   * finished a turn. Keyed off the address so a *new* picture is tried again: without the reset
   * a card that missed once would stay a gradient for as long as the page stayed open.
   */
  const [missingFor, setMissingFor] = useState<string | undefined>(undefined);
  const source = thumbnailUrl(project.projectId, project.updatedAt);
  const missing = missingFor === source;

  return (
    <li className="flex flex-col overflow-hidden rounded-xl border border-edge bg-panel transition-colors hover:border-line-strong">
      <button
        type="button"
        onClick={() => onOpen(project.projectId)}
        className="group flex flex-col text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        <span
          aria-hidden="true"
          className="relative block h-28 w-full overflow-hidden border-edge border-b"
          style={{ background: tileGradient(project.projectId) }}
        >
          {!missing && (
            // Decorative: the button around this already says "Open {name}", and a screenshot
            // of an app is not something a reader can be told anything useful about.
            //
            // `crossOrigin` because the API is another origin and an image request carries no
            // cookie without it — the picture is the caller's own and the route asks who they
            // are. `object-top` so the tile shows the top of the page rather than its middle.
            //
            // `next/image` is not an option and the reason is the cookie again: it fetches
            // through the optimizer, a server holding none of this user's credentials, which
            // would collect a 401 for every card.
            // biome-ignore lint/performance/noImgElement: a private image cannot be optimized by a shared server
            <img
              src={source}
              alt=""
              crossOrigin="use-credentials"
              loading="lazy"
              onError={() => setMissingFor(source)}
              className="size-full object-cover object-top"
            />
          )}
        </span>
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
              aria-label={`Delete ${project.name}`}
              title="Delete project"
              disabled={busy}
              onClick={() => setConfirming(true)}
              className="inline-flex size-6 items-center justify-center rounded-chip text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              <TrashIcon className="size-3.5" />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
