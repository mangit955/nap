"use client";

import type { ProjectSummaryPayload } from "@nap/shared/projects-protocol";
import { NavigationSchema, type SessionSummary } from "@nap/shared/session-navigation";
import { useEffect, useRef, useState } from "react";
import { NapMark } from "../brand/nap-mark.tsx";
import type { useSessionNavigation } from "../projects/use-session-navigation.ts";
import { SpinnerIcon } from "../ui/icons.tsx";
import type { ProjectScope } from "./filters.ts";
import { SessionList } from "./session-list.tsx";

const SCOPES: readonly { id: ProjectScope; label: string }[] = [
  { id: "all", label: "All sessions" },
  { id: "running", label: "Running" },
  { id: "put-away", label: "Put away" },
];
const ROW =
  "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-accent";

export function Sidebar({
  name,
  email,
  avatarUrl,
  scope,
  counts,
  recents,
  onScopeChange,
  onNewProject,
  onApiKey,
  keyHint,
  onSignOut,
  signingOut = false,
  activeProjectId,
  onRename,
  onDelete,
  onClose,
  error,
  loading = false,
  busyProjectId,
  navigation,
  ownerId,
}: {
  ownerId?: string | undefined;
  navigation?: ReturnType<typeof useSessionNavigation> | undefined;
  name: string;
  email: string | undefined;
  avatarUrl?: string | undefined;
  scope: ProjectScope;
  counts: Record<ProjectScope, number>;
  recents: readonly ProjectSummaryPayload[];
  onScopeChange: (scope: ProjectScope) => void;
  onNewProject: () => void;
  onApiKey: () => void;
  keyHint: string | undefined;
  onSignOut: () => void;
  signingOut?: boolean;
  activeProjectId?: string | undefined;
  onRename?: ((id: string, name: string) => void) | undefined;
  onDelete?: ((id: string) => void) | undefined;
  onClose?: ((id: string) => void) | undefined;
  error?: string | undefined;
  loading?: boolean;
  busyProjectId?: string | undefined;
}) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const [draftIds, setDraftIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const refresh = () => {
      if (!ownerId) return;
      try {
        const prefix = `nap.draft.${ownerId}.`;
        setDraftIds(
          new Set(
            Object.keys(localStorage)
              .filter((key) => key.startsWith(prefix))
              .map((key) => key.slice(prefix.length)),
          ),
        );
      } catch {
        /* Optional draft markers. */
      }
    };
    refresh();
    window.addEventListener("storage", refresh);
    window.addEventListener("nap-drafts-changed", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("nap-drafts-changed", refresh);
    };
  }, [ownerId]);
  const [repository, setRepository] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const scroll = useRef<HTMLElement>(null);
  const restoredScroll = useRef(false);
  const revealedProject = useRef<string | undefined>(undefined);
  const navigationStatus = navigation?.status;
  useEffect(() => {
    const element = scroll.current;
    if (loading || (navigationStatus && navigationStatus !== "ready") || !element) return;
    if (!restoredScroll.current) {
      try {
        element.scrollTop = Number(sessionStorage.getItem("nap.sidebar.scroll") ?? 0);
      } catch {
        /* Scrolling also works without persistence. */
      }
      restoredScroll.current = true;
    }
    if (activeProjectId && revealedProject.current !== activeProjectId) {
      const selected = element.querySelector('[aria-current="page"]');
      if (selected) {
        selected.scrollIntoView?.({ block: "nearest" });
        revealedProject.current = activeProjectId;
      }
    }
  }, [loading, activeProjectId, navigationStatus]);
  const sessions: SessionSummary[] =
    navigation?.projects ??
    recents.map((row) => ({
      ...row,
      createdAt: row.updatedAt,
      navigation: NavigationSchema.parse({}),
      revision: 0,
      activity: "ready",
      activityAt: null,
      requestedAt: null,
      repository: null,
      branch: null,
      pullRequest: null,
      pendingFeedback: 0,
    }));
  return (
    <nav
      aria-label="Dashboard"
      className="flex h-full min-h-0 flex-col border-r border-edge bg-sidebar px-2.5 pt-3 pb-2"
    >
      <div className="mb-5 flex h-8 items-center gap-1 pr-8">
        <a
          href="/dashboard"
          aria-label="nap dashboard"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1 text-[13px] text-ink hover:bg-hover"
        >
          <NapMark className="size-6 shrink-0" />
          <span className="truncate font-medium">My workspace</span>
        </a>
        <button
          type="button"
          aria-label="Search sessions"
          title="Search sessions"
          onClick={() => {
            setSearching(!searching);
            if (searching) setQuery("");
            else requestAnimationFrame(() => search.current?.focus());
          }}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-ink"
        >
          <SearchIcon />
        </button>
      </div>
      <button
        type="button"
        data-new-session
        onClick={onNewProject}
        className={`${ROW} bg-hover text-ink`}
      >
        <PlusIcon />
        New session
      </button>
      <a href="/settings/connections" className={ROW}>
        <SettingsIcon />
        Connections
      </a>
      <div className="mt-7 flex items-center justify-between px-3 pb-4">
        <h2 className="text-[13px] font-medium text-ink-2">Sessions</h2>
        <div className="flex gap-1">
          <button
            type="button"
            aria-label="New session"
            data-new-session
            onClick={onNewProject}
            className="rounded p-1 text-muted hover:bg-hover hover:text-ink"
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            aria-label="Filter sessions"
            aria-expanded={filtering}
            onClick={() => setFiltering(!filtering)}
            className="rounded p-1 text-muted hover:bg-hover hover:text-ink"
          >
            <FilterIcon />
          </button>
        </div>
      </div>
      {searching && (
        <input
          ref={search}
          aria-label="Search sessions"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setQuery("");
              setSearching(false);
            }
          }}
          placeholder="Find a session…"
          className="mx-2 mb-3 min-w-0 rounded-lg border border-edge bg-field px-3 py-2 text-sm outline-none focus:border-accent"
        />
      )}
      {filtering && (
        <div className="mb-3 flex flex-col gap-0.5">
          {SCOPES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-label={`${entry.label}, ${counts[entry.id]}`}
              aria-current={scope === entry.id ? true : undefined}
              onClick={() => onScopeChange(entry.id)}
              className={`${ROW} justify-between ${scope === entry.id ? "bg-hover text-ink" : ""}`}
            >
              <span>{entry.label}</span>
              <span className="text-xs text-muted">{counts[entry.id]}</span>
            </button>
          ))}
        </div>
      )}
      <label className="mb-2 px-3 text-[11px] text-muted">
        <span className="sr-only">Repository scope</span>
        <select
          aria-label="Repository scope"
          value={repository}
          onChange={(event) => setRepository(event.target.value)}
          className="w-full bg-sidebar py-2 outline-none focus-visible:outline-accent"
        >
          <option value="">All repositories</option>
          {[...new Set(sessions.flatMap((row) => (row.repository ? [row.repository] : [])))]
            .sort()
            .map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
        </select>
      </label>
      {filtering && (
        <label className="mb-3 flex gap-2 px-3 text-xs text-muted">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          Archived sessions
        </label>
      )}
      <section
        ref={scroll}
        aria-label="Session list"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focus enables native keyboard scrolling.
        tabIndex={0}
        className="nap-scroll-hidden relative min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          if (!restoredScroll.current) return;
          try {
            sessionStorage.setItem("nap.sidebar.scroll", String(event.currentTarget.scrollTop));
          } catch {
            /* Optional scroll restoration. */
          }
        }}
      >
        {loading ? (
          <p role="status" className="px-3 py-3 text-xs text-muted">
            Loading sessions…
          </p>
        ) : (
          <SessionList
            draftIds={draftIds}
            sessions={sessions}
            activeProjectId={activeProjectId}
            scope={scope}
            query={query}
            repository={repository}
            showArchived={showArchived}
            busyProjectId={busyProjectId}
            onChange={navigation ? (id, change) => void navigation.change(id, change) : undefined}
            onReorder={navigation ? (order) => void navigation.reorder(order) : undefined}
            onRename={onRename}
            onDelete={onDelete}
            onClose={onClose}
          />
        )}
        {error && (
          <p role="alert" className="px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
      </section>
      {navigation?.undoAction && (
        <div role="status" className="session-undo">
          <span>{navigation.undoAction.label}</span>
          <button
            type="button"
            disabled={!!navigation.busyProjectId}
            onClick={() => void navigation.undo()}
          >
            Undo
          </button>
          <button type="button" aria-label="Dismiss undo" onClick={navigation.dismissUndo}>
            ×
          </button>
        </div>
      )}
      <div className="relative mt-4 flex shrink-0 items-center gap-0.5 pt-2">
        <AccountMenu
          name={name}
          email={email}
          avatarUrl={avatarUrl}
          keyHint={keyHint}
          onApiKey={onApiKey}
          onSignOut={onSignOut}
          signingOut={signingOut}
        />
        <a
          href="/docs"
          aria-label="Help"
          title="Help"
          className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-ink"
        >
          <HelpIcon />
        </a>
        <details
          className="relative"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.currentTarget.removeAttribute("open");
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}
        >
          <summary
            aria-label="Settings"
            title="Settings"
            className="cursor-pointer list-none rounded-lg p-1.5 text-muted hover:bg-hover hover:text-ink"
          >
            <SettingsIcon />
          </summary>
          <div className="absolute right-0 bottom-full z-40 mb-2 w-48 rounded-xl border border-edge bg-field p-2 shadow-raised">
            <a href="/settings/connections" className={ROW}>
              Connections
            </a>
            <button
              type="button"
              className={ROW}
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                onApiKey();
              }}
            >
              API keys
            </button>
          </div>
        </details>
      </div>
    </nav>
  );
}

export function AccountMenu({
  name,
  email,
  avatarUrl,
  keyHint,
  onApiKey,
  onSignOut,
  signingOut,
}: {
  name: string;
  email: string | undefined;
  avatarUrl?: string | undefined;
  keyHint: string | undefined;
  onApiKey: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  return (
    // The rule below asks for a role, and the right answer here is that this element has none.
    // The interactive things are the button and the menu items inside it; this wrapper exists to
    // know whether the pointer is anywhere on the group, which neither of those can answer on its
    // own. A role would put a second, meaningless node in a reader's way.
    // biome-ignore lint/a11y/noStaticElementInteractions: see above
    <div
      className="relative min-w-0 flex-1"
      onBlur={(event) => {
        // Only when focus has actually left the group — moving between the items inside it is a
        // blur too, and closing on that would make the menu unusable by keyboard.
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        setOpen(false);
        // Back to the trigger rather than nowhere: focus left on a element that just stopped
        // existing is focus on `<body>`, and the next Tab starts from the top of the page.
        trigger.current?.focus();
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((it) => !it)}
        className="flex w-full min-w-0 items-center gap-2.5 rounded-chip px-2.5 py-2 text-left transition-colors hover:bg-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        {avatarUrl ? (
          // biome-ignore lint/performance/noImgElement: account images use the identity provider's URL.
          <img
            src={avatarUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="size-8 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className="grid size-8 shrink-0 place-items-center rounded-full border border-edge bg-hover font-medium text-ink-2 text-xs"
          >
            {name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-ink text-[12px]">{name}</span>
          <span className="truncate text-[11px] text-muted">{email ?? "Personal workspace"}</span>
        </span>
      </button>

      {/*
        After the trigger in the DOM, so Tab out of the name walks into the menu — `bottom-full`
        is what puts it above on screen, and source order is what the keyboard follows.
      */}
      {open && (
        <div role="menu" aria-label="Account" className="absolute right-0 bottom-full left-0 pb-2">
          <div className="flex flex-col gap-0.5 rounded-xl border border-edge bg-panel p-1.5 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.7)]">
            <a
              role="menuitem"
              href="/settings/connections"
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
            >
              <SettingsIcon />
              Connections
            </a>
            <MenuItem onClick={onApiKey}>
              <KeyIcon />
              {keyHint === undefined ? "Add your API key" : `API key · ${keyHint}`}
            </MenuItem>

            {/*
              The ring sits after the words rather than replacing them: swapping the label would
              resize the panel mid-press. `aria-busy` carries the same news to a screen reader,
              which a decorative spinner cannot.
            */}
            <MenuItem onClick={onSignOut} disabled={signingOut} busy={signingOut}>
              <SignOutIcon />
              Sign out
              {signingOut && <SpinnerIcon className="size-3.5 shrink-0 text-muted" />}
            </MenuItem>
          </div>
        </div>
      )}
    </div>
  );
}

/** One line of the account menu. A `menuitem` rather than a button, since it is inside a `menu`. */
function MenuItem({
  onClick,
  disabled = false,
  busy = false,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy || undefined}
      className="flex items-center gap-2.5 rounded-chip px-2.5 py-2 text-left text-ink-2 text-sm transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:hover:bg-transparent disabled:hover:text-ink-2"
    >
      {children}
    </button>
  );
}

const STROKE = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  className: "size-4 shrink-0",
} as const;

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

function KeyIcon() {
  return (
    <svg aria-hidden="true" {...STROKE}>
      <circle cx="5.6" cy="10.4" r="2.6" />
      <path d="m7.5 8.5 5-5M10.6 5.4l1.4 1.4" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg aria-hidden="true" {...STROKE}>
      <path d="M6.5 13.5H3.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3" />
      <path d="M10.5 10.5 13 8l-2.5-2.5M13 8H6.5" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg aria-hidden="true" {...STROKE}>
      <path d="M4 2v3m0 4v5M12 2v7m0 4v1" />
      <circle cx="4" cy="7" r="2" />
      <circle cx="12" cy="11" r="2" />
    </svg>
  );
}
function HelpIcon() {
  return (
    <svg aria-hidden="true" {...STROKE}>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.3 6a1.7 1.7 0 0 1 3.4 0c0 1.5-1.7 1.5-1.7 3M8 11.5h.01" />
    </svg>
  );
}
function SettingsIcon() {
  return (
    <svg aria-hidden="true" {...STROKE}>
      <path d="m6.5 2-.4 1.5-1.5.8L3 4l-1 1.8 1.1 1.1v1.8L2 10l1 1.8 1.6-.3 1.5.8.4 1.7h2.9l.5-1.7 1.5-.8 1.6.3 1-1.8-1.1-1.3V6.9L14 5.8 13 4l-1.6.3-1.5-.8L9.4 2z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}
