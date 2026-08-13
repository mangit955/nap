"use client";

/**
 * The rail: who you are, where you can go, and what you were last working on.
 *
 * It holds no state and asks nothing of the server. The scope it shows as current and the
 * projects it lists come down as props, because the grid to the right is showing the same
 * answer — two components each deciding what "running" means is how a sidebar ends up
 * highlighting a filter the grid is not applying.
 *
 * **Search is a button, not a second box.** The grid already owns a field; a rail with its own
 * would be two inputs filtering one list, which is two answers that can disagree. Pressing this
 * moves the cursor into the one that does the work.
 *
 * The scopes are buttons rather than links: nothing about them changes the address, and a link
 * that does not navigate is a promise to the browser's back button that this page cannot keep.
 */

import type { ProjectSummaryPayload } from "@nap/shared/projects-protocol";
import { NapMark } from "../brand/nap-mark.tsx";
import type { ProjectScope } from "./filters.ts";

const SCOPES: readonly { id: ProjectScope; label: string }[] = [
  { id: "all", label: "All projects" },
  { id: "running", label: "Running" },
  { id: "put-away", label: "Put away" },
];

export function Sidebar({
  name,
  email,
  scope,
  counts,
  recents,
  onScopeChange,
  onSearch,
  onNewProject,
  onApiKey,
  keyHint,
  onSignOut,
}: {
  name: string;
  email: string | undefined;
  scope: ProjectScope;
  counts: Record<ProjectScope, number>;
  /** Newest first, already trimmed to what fits — the rail does not decide how many. */
  recents: readonly ProjectSummaryPayload[];
  onScopeChange: (scope: ProjectScope) => void;
  onSearch: () => void;
  onNewProject: () => void;
  /** Opening the place a key is pasted. The rail is where somebody goes looking for it. */
  onApiKey: () => void;
  /**
   * The masked tail of the key in use, when there is one — `sk-or-…4f2a`.
   *
   * Shown rather than a bare "API key" entry because which state you are in is the thing
   * people actually come here to check, and a menu item that looks identical either way makes
   * them open it to find out. Undefined means the free models, which the label then says.
   */
  keyHint: string | undefined;
  onSignOut: () => void;
}) {
  return (
    <nav
      aria-label="Dashboard"
      className="nap-scroll-hidden flex h-dvh w-full flex-col gap-6 overflow-y-auto border-edge border-r bg-panel px-3 py-4"
    >
      <div className="flex items-center gap-1.5 px-2">
        <NapMark className="size-8" />
        <span className="font-semibold text-ink text-sm tracking-tight">nap</span>
      </div>

      <div className="flex flex-col gap-0.5">
        {/*
          The one item here that is genuinely a link: it is where you already are, but it is a
          real address, and marking it `page` is what tells a reader arriving at the rail which
          of these they are looking at.
        */}
        <a
          href="/dashboard"
          aria-current="page"
          className="flex items-center gap-2.5 rounded-chip bg-hover px-2.5 py-2 font-medium text-ink text-sm focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        >
          <HomeIcon />
          Dashboard
        </a>

        <RailButton onClick={onSearch}>
          <SearchIcon />
          Search
        </RailButton>

        <RailButton onClick={onNewProject}>
          <PlusIcon />
          New project
        </RailButton>
      </div>

      <div className="flex flex-col gap-0.5">
        <h2 className="px-2.5 pb-1 font-medium text-[11px] text-muted uppercase tracking-wider">
          Projects
        </h2>

        {SCOPES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onScopeChange(entry.id)}
            // The label is written out rather than left to the name-from-content algorithm,
            // which joins the two spans with no separator and announces "All projects3".
            aria-label={`${entry.label}, ${counts[entry.id]}`}
            // `aria-current` rather than a colour alone, for the same reason the cards say
            // "running" in words: a highlight is invisible to a reader and ambiguous to anyone
            // who cannot separate two greys.
            {...(scope === entry.id ? { "aria-current": true } : {})}
            className={`flex items-center justify-between rounded-chip px-2.5 py-1.5 text-sm transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
              scope === entry.id
                ? "bg-hover font-medium text-ink"
                : "text-ink-2 hover:bg-hover hover:text-ink"
            }`}
          >
            <span>{entry.label}</span>
            <span className="font-mono text-[11px] text-muted">{counts[entry.id]}</span>
          </button>
        ))}
      </div>

      {recents.length > 0 && (
        <div className="flex min-h-0 flex-col gap-0.5">
          <h2 className="px-2.5 pb-1 font-medium text-[11px] text-muted uppercase tracking-wider">
            Recents
          </h2>

          <ul className="flex flex-col">
            {recents.map((project) => (
              <li key={project.projectId}>
                {/*
                  A plain anchor rather than a router link, like the workspace's own back-link:
                  opening a project should start from a clean page rather than from whatever
                  this one is holding.
                */}
                <a
                  href={`/p/${project.projectId}`}
                  className="block truncate rounded-chip px-2.5 py-1.5 text-ink-2 text-sm transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                >
                  {project.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-1 border-edge border-t pt-3">
        <div className="flex min-w-0 items-center gap-2.5 px-2.5">
          <span
            aria-hidden="true"
            className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-tint font-medium text-accent-ink text-xs"
          >
            {name.slice(0, 1).toUpperCase()}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-ink text-sm">{name}</span>
            {email !== undefined && (
              <span className="truncate text-[11px] text-muted">{email}</span>
            )}
          </span>
        </div>

        <RailButton onClick={onApiKey}>
          {keyHint === undefined ? "Add your API key" : `API key · ${keyHint}`}
        </RailButton>

        <RailButton onClick={onSignOut}>Sign out</RailButton>
      </div>
    </nav>
  );
}

/** Everything in the rail that does something rather than going somewhere. */
function RailButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2.5 rounded-chip px-2.5 py-2 text-ink-2 text-sm transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
    >
      {children}
    </button>
  );
}

/*
 * The icons are `aria-hidden` and the label beside each is the accessible name — an icon that
 * announced itself would have every item read out twice. The attribute is written on each
 * `<svg>` rather than folded into this object, because the lint rule that insists an icon be
 * either labelled or hidden cannot see through a spread and fails the file.
 */
const STROKE = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  className: "size-4 shrink-0",
} as const;

function HomeIcon() {
  return (
    <svg aria-hidden="true" {...STROKE}>
      <path d="M2.5 6.8 8 2.5l5.5 4.3V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" {...STROKE}>
      <circle cx="7.2" cy="7.2" r="4.2" />
      <path d="m10.4 10.4 3 3" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" {...STROKE}>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}
