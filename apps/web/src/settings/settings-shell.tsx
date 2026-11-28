"use client";

/**
 * The frame every settings page sits in: a rail of settings on the left, a breadcrumb along the
 * top, and the page scrolling on its own beneath both, so the way back never scrolls away.
 *
 * On narrow screens the settings links sit above the breadcrumb.
 */

import { Archive, PanelLeft } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApiKeyPanel } from "../account/api-key-panel.tsx";
import { useApiKey } from "../account/use-api-key.ts";
import { ArrowLeftIcon, ConnectionsIcon, HelpIcon, KeyIcon, SearchIcon } from "../ui/icons.tsx";
import { FOCUS } from "./settings-ui.tsx";

export type Crumb = { label: string; href?: string };

const ITEM = `flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors ${FOCUS}`;

export function SettingsShell({
  crumbs,
  draftId,
  nested = false,
  activePage = "connections",
  onApiKey,
  children,
}: {
  crumbs: readonly Crumb[];
  /** A composer draft to return to after visiting settings. */
  draftId?: string | undefined;
  /** The page sits beneath the rail's Connections entry rather than being it. */
  nested?: boolean;
  activePage?: "connections" | "archived" | "sidebar";
  /**
   * Opens the API key dialog. A page that already shows the key's state passes its own, so the
   * rail and the page answer from one state; without it the rail opens a dialog of its own.
   */
  onApiKey?: () => void;
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  // Undefined until the rail's own key dialog is first opened. After that it stays mounted, so
  // closing it goes through the element's `close()` and focus returns to the button — a dialog
  // unmounted while open drops focus on <body>.
  const [keyOpen, setKeyOpen] = useState<boolean>();
  const search = useRef<HTMLInputElement>(null);

  // `/` jumps to the settings search, as the hint inside the field says — unless the key is
  // being typed into something. Search can be hidden on narrow screens or inert behind a modal.
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select") !== null)
      )
        return;
      search.current?.focus();
      if (document.activeElement === search.current) event.preventDefault();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const needle = query.trim().toLowerCase();
  const matches = (label: string) => label.toLowerCase().includes(needle);

  const draft = draftId ? `?draft=${draftId}` : "";
  const appHref = draftId ? `/dashboard${draft}&repositories=1` : "/dashboard";

  return (
    <div className="flex h-dvh flex-col bg-surface text-ink md:flex-row">
      <aside className="flex shrink-0 flex-col border-edge/55 border-b bg-sidebar md:w-72 md:border-r md:border-b-0">
        <div className="flex h-11 shrink-0 items-center px-3">
          <a
            href={appHref}
            className={`flex items-center gap-2 rounded-md px-2 py-1 text-[13px] text-ink-2 transition-colors hover:text-ink ${FOCUS}`}
          >
            <ArrowLeftIcon className="size-3.5" />
            Back to app
          </a>
        </div>
        <div className={query ? "px-3 pt-1" : "hidden px-3 pt-1 md:block"}>
          <label className="flex h-8 items-center gap-2 rounded-lg border border-edge/55 bg-field px-2.5 text-muted focus-within:border-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent">
            <SearchIcon className="size-3.5 shrink-0" />
            <input
              ref={search}
              type="search"
              aria-label="Search settings"
              placeholder="Search settings…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-muted"
            />
            <kbd className="rounded border border-edge/55 px-1.5 font-sans text-[11px] leading-4 text-muted">
              /
            </kbd>
          </label>
        </div>
        <nav
          aria-label="Settings"
          className="min-h-0 flex-1 overflow-auto px-2 py-1 md:mt-6 md:px-3 md:py-0"
        >
          <p className="hidden px-2 pb-1.5 text-xs text-muted md:block">Personal</p>
          <ul className="grid grid-cols-2 gap-1 md:block md:space-y-0.5">
            {matches("Connections") && (
              <li>
                <a
                  href={`/settings/connections${draft}`}
                  aria-current={
                    activePage === "connections" ? (nested ? "true" : "page") : undefined
                  }
                  className={`${ITEM} ${activePage === "connections" ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover"}`}
                >
                  <ConnectionsIcon className="size-4 text-ink-2" />
                  Connections
                </a>
              </li>
            )}
            {matches("Archived sessions") && (
              <li>
                <a
                  href={`/settings/archived${draft}`}
                  aria-current={activePage === "archived" ? "page" : undefined}
                  className={`${ITEM} ${activePage === "archived" ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover"}`}
                >
                  <Archive aria-hidden="true" className="size-4 shrink-0 text-ink-2" />
                  Archived sessions
                </a>
              </li>
            )}
            {matches("Sidebar") && (
              <li>
                <a
                  href={`/settings/sidebar${draft}`}
                  aria-current={activePage === "sidebar" ? "page" : undefined}
                  className={`${ITEM} ${activePage === "sidebar" ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover"}`}
                >
                  <PanelLeft aria-hidden="true" className="size-4 shrink-0 text-ink-2" />
                  Sidebar
                </a>
              </li>
            )}
            {matches("API key") && (
              <li>
                <button
                  type="button"
                  onClick={() => (onApiKey ? onApiKey() : setKeyOpen(true))}
                  className={`${ITEM} text-ink-2 hover:bg-hover hover:text-ink`}
                >
                  <KeyIcon className="size-4" />
                  API key
                </button>
              </li>
            )}
          </ul>
          {!matches("Connections") &&
            !matches("API key") &&
            !matches("Archived sessions") &&
            !matches("Sidebar") && (
              <p className="px-2 py-1.5 text-[13px] text-muted">No settings match.</p>
            )}
        </nav>
        <div className="hidden p-3 md:block">
          <a
            href="/docs"
            aria-label="Documentation"
            className={`flex size-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-ink ${FOCUS}`}
          >
            <HelpIcon className="size-4" />
          </a>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-edge/55 px-4 sm:px-6">
          <nav aria-label="Breadcrumb" className="min-w-0">
            <ol className="flex items-center gap-2 text-[13px]">
              {crumbs.map((crumb, index) => {
                const last = index === crumbs.length - 1;
                return (
                  <li key={crumb.label} className="flex min-w-0 items-center gap-2">
                    {index > 0 && (
                      <span aria-hidden="true" className="text-line-strong">
                        /
                      </span>
                    )}
                    {last ? (
                      <span aria-current="page" className="truncate text-ink">
                        {crumb.label}
                      </span>
                    ) : crumb.href ? (
                      <a
                        href={crumb.href}
                        className={`truncate rounded text-ink-2 transition-colors hover:text-ink ${FOCUS}`}
                      >
                        {crumb.label}
                      </a>
                    ) : (
                      <span className="truncate text-ink-2">{crumb.label}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto px-5 pt-8 pb-20 sm:px-6">
          <div className="mx-auto w-full max-w-[720px]">{children}</div>
        </main>
      </div>

      {keyOpen !== undefined && <RailKeyDialog open={keyOpen} onClose={() => setKeyOpen(false)} />}
    </div>
  );
}

/** Mounted on first open, so a settings page that never opens it never asks for the key. */
function RailKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const key = useApiKey();
  return <ApiKeyPanel open={open} onClose={onClose} keyState={key} />;
}
