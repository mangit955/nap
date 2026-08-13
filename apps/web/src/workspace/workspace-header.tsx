"use client";

/**
 * One bar across the top of the workspace: what this project is, which half of the workbench is
 * showing, and the controls that belong to the app running inside it.
 *
 * They are gathered here rather than left on each pane because there is now one workbench with
 * two faces, and a Reload button that lived inside the preview would disappear when somebody
 * switched to the code — while still being the control they wanted.
 *
 * **Nothing here is decoration.** There is no Share, Publish or Upgrade: this deployment has no
 * such features, and a button that does nothing teaches people that the other buttons might not
 * work either.
 */

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { NapMark } from "../brand/nap-mark.tsx";
import { EditableTitle } from "../ui/editable-title.tsx";
import { ExternalIcon, PanelIcon, ReloadIcon } from "../ui/icons.tsx";
import { normaliseRoute, previewUrlFor } from "./route-path.ts";
import { WORKBENCH_TABS, type WorkbenchTab } from "./tabs.ts";

export function WorkspaceHeader({
  projectName,
  onRename,
  tab,
  chatOpen,
  route,
  previewUrl,
  onTabChange,
  onReload,
  onRouteChange,
  onToggleChat,
}: {
  projectName: string;
  /** Absent while the bar is showing a sentence rather than a name; see below. */
  onRename?: ((name: string) => Promise<string | undefined>) | undefined;
  tab: WorkbenchTab;
  chatOpen: boolean;
  /** The page the frame was last sent to. Always a path; see `route-path.ts`. */
  route: string;
  /** The sandbox's address, or absent while nothing is serving the project. */
  previewUrl: string | undefined;
  onTabChange: (tab: WorkbenchTab) => void;
  onReload: () => void;
  onRouteChange: (route: string) => void;
  onToggleChat: () => void;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <IconButton
          label={chatOpen ? "Hide chat" : "Show chat"}
          onClick={onToggleChat}
          // The label says what pressing it does, not what is on screen — a toggle named after
          // its current state reads as a claim rather than an action.
        >
          <PanelIcon open={chatOpen} />
        </IconButton>

        {/*
          A plain anchor rather than a router link: leaving the workspace should drop the socket
          and every pending request, and a full navigation is the simplest thing that does that.
        */}
        <a
          href="/dashboard"
          className="flex shrink-0 items-center gap-1 font-semibold text-ink text-sm tracking-tight hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        >
          <NapMark className="size-6" />
          nap
        </a>

        <span aria-hidden="true" className="text-muted">
          /
        </span>
        {/*
          Editable only when it is a name. `headerNote` puts sentences here for the loading,
          missing and error states — "this project no longer exists" is not something anybody
          should be able to type over, and offering to rename a project that is gone is worse
          than saying nothing.
        */}
        {onRename === undefined ? (
          <span className="truncate text-ink-2 text-sm">{projectName}</span>
        ) : (
          <EditableTitle
            name={projectName}
            onRename={onRename}
            className="text-ink-2 text-sm"
            inputClassName="text-sm w-44"
          />
        )}
      </div>

      <div
        role="tablist"
        aria-label="Workbench"
        className="flex shrink-0 items-center gap-0.5 rounded-chip bg-field p-0.5 shadow-hairline"
      >
        {WORKBENCH_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`workbench-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`workbench-${entry.id}`}
            onClick={() => onTabChange(entry.id)}
            className={`rounded-[5px] px-3 py-1 text-xs transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
              tab === entry.id ? "bg-hover font-medium text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="flex flex-1 items-center justify-end gap-2">
        {previewUrl !== undefined && (
          <>
            <RouteField route={route} onRouteChange={onRouteChange} />

            <IconButton label="Reload the preview" onClick={onReload}>
              <ReloadIcon />
            </IconButton>

            <a
              href={previewUrlFor(previewUrl, route)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open the preview in a new tab"
              className="grid size-7 place-items-center rounded-chip text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              <ExternalIcon />
            </a>
          </>
        )}
      </div>
    </header>
  );
}

/**
 * Where to send the frame.
 *
 * **It is a control, not an address bar**, and the difference is not pedantic: the preview is
 * another origin, so a link clicked inside the app changes the page without this box hearing a
 * word about it. Labelled "Page" for that reason — it says where the frame is being sent, and
 * claiming to say where it *is* would be a lie a third of the time.
 *
 * Its own state while being typed in, committed on submit, so the frame is not reloaded on every
 * keystroke of `/pricing`.
 */
function RouteField({
  route,
  onRouteChange,
}: {
  route: string;
  onRouteChange: (route: string) => void;
}) {
  const [draft, setDraft] = useState(route);

  // Whatever sent the frame elsewhere — a reset, another tab of the same project — is what this
  // box should be showing.
  useEffect(() => setDraft(route), [route]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // Tidied here rather than by the caller: this field's whole contract is that it hands
        // out a *path*, and a caller that had to remember to normalise would eventually forget
        // — which is how `//evil.example` reaches an iframe's src.
        onRouteChange(normaliseRoute(draft));
      }}
      className="hidden min-w-0 flex-1 sm:block"
    >
      <input
        aria-label="Page to show"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => setDraft(route)}
        spellCheck={false}
        className="w-full rounded-chip border border-edge bg-field px-3 py-1 font-mono text-[11px] text-ink-2 outline-none placeholder:text-muted focus-visible:border-line-strong"
      />
    </form>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid size-7 shrink-0 place-items-center rounded-chip text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
    >
      {children}
    </button>
  );
}

/*
 * The icons live in `ui/icons.tsx` — one set for the whole workspace, so a chevron in this bar
 * and a chevron in the file tree are the same shape at the same weight. See that file for why
 * each one writes its own `aria-hidden`.
 */
