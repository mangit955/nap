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
import { hostOf, normaliseRoute, previewUrlFor } from "./route-path.ts";
import { WORKBENCH_TABS, type WorkbenchTab } from "./tabs.ts";

export function WorkspaceHeader({
  projectName,
  tab,
  chatOpen,
  route,
  previewUrl,
  status,
  onTabChange,
  onReload,
  onRouteChange,
  onToggleChat,
}: {
  projectName: string;
  tab: WorkbenchTab;
  chatOpen: boolean;
  /** The page the frame was last sent to. Always a path; see `route-path.ts`. */
  route: string;
  /** The sandbox's address, or absent while nothing is serving the project. */
  previewUrl: string | undefined;
  /** The connection indicator, passed in so this bar needs no socket of its own. */
  status: ReactNode;
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
        <span className="truncate text-ink-2 text-sm">{projectName}</span>
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
            <span
              // Which machine is serving this, for anybody comparing two tabs. Hidden on a
              // narrow window, where the route matters and the host is thirty characters of
              // random subdomain.
              className="hidden shrink-0 font-mono text-[11px] text-muted lg:block"
            >
              {hostOf(previewUrl)}
            </span>

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

        {status}
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
 * The icons are `aria-hidden` — each button carries its own label, and an icon that announced
 * itself would have every control read out twice. The attribute is written on each `<svg>`
 * rather than folded into the shared props, because the lint rule that insists an icon be either
 * labelled or hidden cannot see through a spread.
 */
const STROKE = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  className: "size-4",
} as const;

function PanelIcon({ open }: { open: boolean }) {
  return (
    <svg aria-hidden="true" {...STROKE}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6.5 3v10" />
      {/* Filled while the chat is showing, so the button reads as a state as well as an action. */}
      {open && <path d="M4.2 3.2v9.6" strokeWidth="2.6" />}
    </svg>
  );
}

function ReloadIcon() {
  return (
    <svg aria-hidden="true" {...STROKE}>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13.2 2.6v2.6h-2.6" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg aria-hidden="true" {...STROKE}>
      <path d="M9.5 3h3.5v3.5" />
      <path d="m13 3-5 5" />
      <path d="M12 10v2.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H6" />
    </svg>
  );
}
