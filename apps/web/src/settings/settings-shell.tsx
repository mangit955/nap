"use client";

/**
 * The frame every settings page sits in: a rail of settings on the left, a breadcrumb along the
 * top, and the page scrolling on its own beneath both, so the way back never scrolls away.
 *
 * Laid out after Devin's settings. The rail lists only pages and dialogs that exist — a rail
 * padded with entries that lead nowhere would look more like the reference and be worse to use.
 * Below `md` the rail is hidden and each page's own back link is the way out.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApiKeyPanel } from "../account/api-key-panel.tsx";
import { useApiKey } from "../account/use-api-key.ts";
import { ArrowLeftIcon, ConnectionsIcon, HelpIcon, KeyIcon, SearchIcon } from "../ui/icons.tsx";

export type Crumb = { label: string; href?: string };

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const ITEM = `flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors ${FOCUS}`;

export function SettingsShell({
  crumbs,
  appHref = "/dashboard",
  onApiKey,
  children,
}: {
  crumbs: readonly Crumb[];
  /** Where "Back to app" goes — a draft's own address when the visit started from one. */
  appHref?: string;
  /**
   * Opens the API key dialog. A page that already shows the key's state passes its own, so the
   * rail and the page answer from one state; without it the rail opens a dialog of its own.
   */
  onApiKey?: () => void;
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [keyOpen, setKeyOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);

  // `/` jumps to the settings search, as the hint inside the field says — unless the key is
  // being typed into something.
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select") !== null)
      )
        return;
      event.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const needle = query.trim().toLowerCase();
  const matches = (label: string) => label.toLowerCase().includes(needle);

  return (
    <div className="flex h-dvh bg-surface text-ink">
      <aside className="hidden w-72 shrink-0 flex-col border-r border-edge bg-sidebar md:flex">
        <div className="flex h-11 shrink-0 items-center px-3">
          <a
            href={appHref}
            className={`flex items-center gap-2 rounded-md px-2 py-1 text-[13px] text-ink-2 transition-colors hover:text-ink ${FOCUS}`}
          >
            <ArrowLeftIcon className="size-3.5" />
            Back to app
          </a>
        </div>
        <div className="px-3 pt-1">
          <label className="flex h-8 items-center gap-2 rounded-lg border border-edge bg-field px-2.5 text-muted focus-within:border-line-strong">
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
            <kbd className="rounded border border-edge px-1.5 font-sans text-[11px] leading-4 text-muted">
              /
            </kbd>
          </label>
        </div>
        <nav aria-label="Settings" className="mt-6 min-h-0 flex-1 overflow-y-auto px-3">
          <p className="px-2 pb-1.5 text-xs text-muted">Personal</p>
          <ul className="space-y-0.5">
            {matches("Connections") && (
              <li>
                <a
                  href="/settings/connections"
                  aria-current="true"
                  className={`${ITEM} bg-hover text-ink`}
                >
                  <ConnectionsIcon className="size-4 text-ink-2" />
                  Connections
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
          {!matches("Connections") && !matches("API key") && (
            <p className="px-2 py-1.5 text-[13px] text-muted">No settings match.</p>
          )}
        </nav>
        <div className="p-3">
          <a
            href="/docs"
            aria-label="Documentation"
            className={`flex size-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-ink ${FOCUS}`}
          >
            <HelpIcon className="size-4" />
          </a>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center border-b border-edge px-5 sm:px-6">
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
        <main className="min-h-0 flex-1 overflow-y-auto px-5 pb-20 pt-5 sm:px-6">{children}</main>
      </div>

      {keyOpen && <RailKeyDialog onClose={() => setKeyOpen(false)} />}
    </div>
  );
}

/** Mounted only while open, so a settings page that never opens it never asks for the key. */
function RailKeyDialog({ onClose }: { onClose: () => void }) {
  const key = useApiKey();
  return <ApiKeyPanel open onClose={onClose} keyState={key} />;
}
