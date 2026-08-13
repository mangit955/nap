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
import { useRef, useState } from "react";
import { NapMark } from "../brand/nap-mark.tsx";
import { SpinnerIcon } from "../ui/icons.tsx";
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
  signingOut = false,
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
  /**
   * Whether signing out is in flight.
   *
   * Worth showing because it is the one action in this rail that is neither instant nor
   * visible: the request crosses the network to drop the session, and until the redirect lands
   * the page looks exactly as it did before the press. Without a mark, a slow one reads as a
   * button that did nothing and gets pressed again.
   */
  signingOut?: boolean;
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

      <div className="mt-auto border-edge border-t pt-3">
        <AccountMenu
          name={name}
          email={email}
          keyHint={keyHint}
          onApiKey={onApiKey}
          onSignOut={onSignOut}
          signingOut={signingOut}
        />
      </div>
    </nav>
  );
}

/**
 * Who you are, and the two things you can do about it.
 *
 * The account's own actions used to sit in the rail as two more items, level with Search and New
 * project — which put "Sign out" one careless click from "Dashboard" and gave a key you set once a
 * permanent line of a menu you read every day. They live behind the name now: the rail lists
 * places to go, and this is the one entry that is a *person* rather than a destination.
 *
 * **It opens on a press and on nothing else.** Not hover: a menu that appears because the pointer
 * passed over the corner of the rail is one that opens when nobody asked, and it covers the
 * recents list while they are reading it. Click or Enter toggles it, Escape closes it and hands
 * focus back, and focus leaving the group closes it. `aria-haspopup` and `aria-expanded` are what
 * say all of that to a reader.
 *
 * **Focus deliberately does not open it either.** It did, and that made Escape look ignored:
 * closing hands focus back to the trigger, and the trigger taking focus reopened the menu.
 *
 * **The gap above the trigger is padding, not space.** The panel floats clear of the name by 8px,
 * and if that were a true gap the pointer would leave the group crossing it and the menu would
 * shut under the cursor. It is `pb-2` inside the panel's own box instead, so the whole path from
 * name to menu item stays inside one element.
 */
function AccountMenu({
  name,
  email,
  keyHint,
  onApiKey,
  onSignOut,
  signingOut,
}: {
  name: string;
  email: string | undefined;
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
        className="flex w-full min-w-0 items-center gap-2.5 rounded-chip px-2.5 py-2 text-left transition-colors hover:bg-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        <span
          aria-hidden="true"
          className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-tint font-medium text-accent-ink text-xs"
        >
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-ink text-sm">{name}</span>
          {email !== undefined && <span className="truncate text-[11px] text-muted">{email}</span>}
        </span>
      </button>

      {/*
        After the trigger in the DOM, so Tab out of the name walks into the menu — `bottom-full`
        is what puts it above on screen, and source order is what the keyboard follows.
      */}
      {open && (
        <div role="menu" aria-label="Account" className="absolute right-0 bottom-full left-0 pb-2">
          <div className="flex flex-col gap-0.5 rounded-xl border border-edge bg-panel p-1.5 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.7)]">
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

/** Everything in the rail that does something rather than going somewhere. */
function RailButton({
  onClick,
  disabled = false,
  busy = false,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  /** Announced as `aria-busy`, for an item whose spinner says nothing to a screen reader. */
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy || undefined}
      className="flex items-center gap-2.5 rounded-chip px-2.5 py-2 text-ink-2 text-sm transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:hover:bg-transparent disabled:hover:text-ink-2"
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
