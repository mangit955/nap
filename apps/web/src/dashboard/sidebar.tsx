"use client";

import type { ProjectSummaryPayload } from "@nap/shared/projects-protocol";
import { NavigationSchema, type SessionSummary } from "@nap/shared/session-navigation";
import { SquarePen } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { NapMark } from "../brand/nap-mark.tsx";
import type { useSessionNavigation } from "../projects/use-session-navigation.ts";
import { ProvidersIcon, SpinnerIcon } from "../ui/icons.tsx";
import { DraftRows } from "./draft-rows.tsx";
import { SessionList } from "./session-list.tsx";
import { SourceFilter } from "./source-filter.tsx";

const ROW =
  "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-accent";

export function Sidebar({
  name,
  email,
  avatarUrl,
  recents,
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
  recents: readonly ProjectSummaryPayload[];
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
  const scroll = useRef<HTMLElement>(null);
  const restoredScroll = useRef(false);
  const revealedSelection = useRef<HTMLAnchorElement | null>(null);
  const navigationStatus = navigation?.status;
  const onListLayout = useCallback(
    (selected: HTMLAnchorElement | null) => {
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
      if (selected && revealedSelection.current !== selected) {
        selected.scrollIntoView?.({ block: "nearest" });
      }
      revealedSelection.current = selected;
    },
    [loading, navigationStatus],
  );
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
      <a
        href="/dashboard"
        aria-label="nap dashboard"
        className="mb-3 flex h-8 items-center gap-2 px-2 text-sm font-medium text-ink"
      >
        <NapMark className="size-6" /> nap
      </a>
      <div className="relative mb-3 flex h-8 items-center gap-1">
        <label className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md border border-edge px-2 text-muted focus-within:border-accent">
          <SearchIcon />
          <input
            aria-label="Search sessions"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("");
            }}
            className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none"
          />
        </label>
        <SourceFilter sessions={sessions} value={repository} onChange={setRepository} />
        <button
          type="button"
          aria-label="New session"
          title="New session"
          data-new-session
          onClick={onNewProject}
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-ink"
        >
          <SquarePen className="size-4" aria-hidden />
        </button>
      </div>
      <section
        ref={scroll}
        aria-label="Session list"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focus enables native keyboard scrolling.
        tabIndex={0}
        className="nap-scroll-hidden relative flex min-h-0 flex-1 flex-col overflow-y-auto"
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
          <>
            <DraftRows
              ownerId={ownerId}
              draftIds={draftIds}
              sessions={sessions}
              query={query}
              repository={repository}
            />
            <div className="flex-1">
              <SessionList
                onLayout={onListLayout}
                ownerId={ownerId}
                draftIds={draftIds}
                sessions={sessions}
                activeProjectId={activeProjectId}
                query={query}
                repository={repository}
                busyProjectId={busyProjectId}
                onChange={
                  navigation ? (id, change) => void navigation.change(id, change) : undefined
                }
                onReorder={navigation ? (order) => void navigation.reorder(order) : undefined}
                onRename={onRename}
                onDelete={onDelete}
                onClose={onClose}
              />
            </div>
          </>
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
      className="relative"
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
        aria-label="Settings"
        title="Settings"
        className="grid size-8 place-items-center rounded-md text-muted hover:bg-hover hover:text-ink focus-visible:outline-accent"
      >
        <SettingsIcon />
      </button>

      {/*
        After the trigger in the DOM, so Tab out of the name walks into the menu — `bottom-full`
        is what puts it above on screen, and source order is what the keyboard follows.
      */}
      {/*
        `z-50`, the sidebar's other menus' layer, because the sidebar's resize handle sits at 45 on
        the column edge this menu overhangs. Below it, the handle drew its line through the glass
        and took the pointer on that strip.
      */}
      {open && (
        <div
          role="menu"
          aria-label="Settings"
          className="absolute left-0 bottom-full z-50 w-64 pb-2"
        >
          <div className="composer-surface nap-float flex flex-col gap-0.5 rounded-[10px] p-1.5">
            <div className="flex items-center gap-2 border-b border-edge px-3 py-3">
              {avatarUrl && (
                // biome-ignore lint/performance/noImgElement: account avatar uses the identity provider URL.
                <img
                  src={avatarUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="size-7 rounded-full"
                />
              )}
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">{name}</p>
                <p className="truncate text-xs text-muted">{email ?? "Personal workspace"}</p>
              </div>
            </div>
            <a role="menuitem" href="/settings/archived" className={ROW}>
              Archived sessions
            </a>
            <a
              role="menuitem"
              href="/settings/connections"
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
            >
              <SettingsIcon />
              Connections
            </a>
            <a
              role="menuitem"
              href="/settings/providers"
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
            >
              <ProvidersIcon className="size-4 shrink-0" />
              Providers
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
