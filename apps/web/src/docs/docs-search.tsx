"use client";

/**
 * The docs' search: ⌘K (Ctrl K elsewhere) or `/` from anywhere in the docs, or any of the search
 * fields, opens one dialog over the page.
 *
 * **A real `<dialog>` opened with `showModal`**, for the reasons `docs/gotchas/web.md` gives: the
 * focus trap, Escape, the inert page behind it and focus returning to whatever opened it all come
 * from the browser. A click on the backdrop closes it through the native `closedby="any"`.
 *
 * **The typing never leaves the input.** It is a combobox: the arrow keys move the highlighted
 * result by `aria-activedescendant`, Enter opens it, and a screen reader hears each result as it is
 * highlighted. The results are links all the same, so a pointer, a middle-click or "open in new
 * tab" behave as they would anywhere else.
 */

import { Hash, House, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { pageById } from "./pages.ts";
import { type Hit, highlight, type SearchEntry, search, termsOf } from "./search.ts";

const OpenSearch = createContext<() => void>(() => {});

/** Opens the search dialog. Every search field in the docs is a button that calls this. */
export function useOpenSearch(): () => void {
  return useContext(OpenSearch);
}

export function SearchProvider({
  entries,
  children,
}: {
  entries: readonly SearchEntry[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
        return;
      }
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !isTyping(event.target)) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <OpenSearch.Provider value={show}>
      {children}
      {open && <SearchDialog entries={entries} onClose={() => setOpen(false)} />}
    </OpenSearch.Provider>
  );
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

function SearchDialog({
  entries,
  onClose,
}: {
  entries: readonly SearchEntry[];
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const ids = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const results = useMemo(() => search(entries, query), [entries, query]);
  const hits = useMemo(() => [...results.pages, ...results.sections], [results]);
  const terms = useMemo(() => termsOf(query), [query]);
  const optionId = (index: number) => `${ids}-option-${index}`;

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at the top result.
  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    list.current
      ?.querySelector(`[id="${optionId(active)}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  });

  const close = () => dialog.current?.close();

  const open = (hit: Hit | undefined) => {
    if (!hit) return;
    router.push(hit.entry.href);
    close();
  };

  return (
    <dialog
      ref={dialog}
      aria-label="Search the docs"
      closedby="any"
      onClose={onClose}
      className="docs-search-dialog"
    >
      <div className="docs-search-query">
        <Search aria-hidden="true" size={18} />
        <input
          autoFocus
          type="text"
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls={`${ids}-results`}
          aria-activedescendant={hits.length > 0 ? optionId(active) : undefined}
          aria-autocomplete="list"
          aria-label="Search the docs"
          placeholder="Search docs…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (hits.length === 0) return;
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((current) => (current + step + hits.length) % hits.length);
            } else if (event.key === "Enter") {
              event.preventDefault();
              open(hits[active]);
            }
          }}
          className="docs-search-input"
        />
        <kbd className="docs-kbd">esc</kbd>
      </div>

      <div
        ref={list}
        id={`${ids}-results`}
        role="listbox"
        aria-label="Results"
        className="docs-search-results"
      >
        {hits.length === 0 ? (
          <p className="docs-search-empty">No results for “{query.trim()}”.</p>
        ) : (
          <>
            <Group
              name={query.trim() ? "Pages" : "All pages"}
              hits={results.pages}
              offset={0}
              {...{ active, terms, optionId, setActive, close }}
            />
            <Group
              name="Sections"
              hits={results.sections}
              offset={results.pages.length}
              {...{ active, terms, optionId, setActive, close }}
            />
          </>
        )}
      </div>

      <div className="docs-search-foot" aria-hidden="true">
        <span>
          <kbd className="docs-kbd">↵</kbd> to open
        </span>
        <span>
          <kbd className="docs-kbd">↑</kbd>
          <kbd className="docs-kbd">↓</kbd> to move
        </span>
        <span className="docs-search-foot-note">Searches every heading and paragraph</span>
      </div>
    </dialog>
  );
}

function Group({
  name,
  hits,
  offset,
  active,
  terms,
  optionId,
  setActive,
  close,
}: {
  name: string;
  hits: readonly Hit[];
  offset: number;
  active: number;
  terms: readonly string[];
  optionId: (index: number) => string;
  setActive: (index: number) => void;
  close: () => void;
}) {
  if (hits.length === 0) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a listbox's groups have no native element; `fieldset` is for form controls.
    <div role="group" aria-label={name}>
      <p className="docs-search-group" aria-hidden="true">
        {name}
      </p>
      {hits.map((hit, index) => {
        const position = offset + index;
        const Icon =
          hit.entry.kind === "section" ? Hash : (pageById(hit.entry.pageId ?? "")?.Icon ?? House);
        return (
          <Link
            key={hit.entry.href}
            id={optionId(position)}
            href={hit.entry.href}
            role="option"
            aria-selected={position === active}
            tabIndex={-1}
            className="docs-search-hit"
            onMouseMove={() => {
              if (position !== active) setActive(position);
            }}
            onClick={close}
          >
            <Icon aria-hidden="true" size={17} />
            <span>
              <span className="docs-search-path">{hit.entry.context}</span>
              <span className="docs-search-title">
                <Marked text={hit.entry.title} terms={terms} />
              </span>
              {hit.snippet && (
                <span className="docs-search-snippet">
                  <Marked text={hit.snippet} terms={terms} />
                </span>
              )}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

function Marked({ text, terms }: { text: string; terms: readonly string[] }) {
  return (
    <>
      {highlight(text, terms).map((run, index) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: runs are a pure function of the text; their order is their identity.
        run.match ? <mark key={index}>{run.text}</mark> : <span key={index}>{run.text}</span>,
      )}
    </>
  );
}
