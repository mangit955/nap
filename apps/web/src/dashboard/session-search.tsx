"use client";

/**
 * The sidebar search's results, drawn as T3's listbox: each session the server found, by its name
 * or by one of the person's own messages, with the match marked. Text and `<mark>` only — a
 * message is never rendered as HTML.
 *
 * The input stays focused throughout (the combobox pattern), so the options are reached with the
 * arrow keys from it; `activeIndex` is owned by the sidebar, which owns the input.
 */

import type { SessionSearchResult } from "@nap/shared/session-navigation";
import type { MouseEvent } from "react";
import { highlightSegments, type SessionSearchState } from "../projects/use-session-search.ts";

export const SEARCH_LISTBOX_ID = "session-search-results";
export const searchOptionId = (index: number) => `${SEARCH_LISTBOX_ID}-${index}`;

export function SessionSearchResults({
  state,
  activeIndex,
  onSelect,
}: {
  state: SessionSearchState;
  activeIndex: number;
  /** Opening a result in place, as a row's own click does; absent, the link navigates. */
  onSelect?: ((projectId: string) => void) | undefined;
}) {
  if (state.status === "idle") return null;
  const results = state.status === "ready" ? state.results : [];
  return (
    <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-lg border border-edge bg-surface p-1 shadow-lg">
      {state.status === "loading" && (
        <p role="status" className="px-2 py-1.5 text-xs text-muted">
          Searching…
        </p>
      )}
      {state.status === "error" && (
        <p role="alert" className="px-2 py-1.5 text-xs text-danger">
          {state.error}
        </p>
      )}
      {state.status === "ready" && results.length === 0 && (
        <p role="status" className="px-2 py-1.5 text-xs text-muted">
          No sessions match “{state.query}”.
        </p>
      )}
      {results.length > 0 && (
        <div id={SEARCH_LISTBOX_ID} role="listbox" aria-label="Search results">
          {results.map((result, index) => (
            <SearchOption
              key={result.projectId}
              id={searchOptionId(index)}
              result={result}
              query={state.status === "ready" ? state.query : ""}
              active={index === activeIndex}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SearchOption({
  id,
  result,
  query,
  active,
  onSelect,
}: {
  id: string;
  result: SessionSearchResult;
  query: string;
  active: boolean;
  onSelect?: ((projectId: string) => void) | undefined;
}) {
  const match = result.match;
  return (
    <a
      id={id}
      role="option"
      aria-selected={active}
      href={`/p/${result.projectId}`}
      // Keeps focus in the search box, so choosing with the mouse does not first close the list.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0;
        if (!onSelect || modified) return;
        event.preventDefault();
        onSelect(result.projectId);
      }}
      className={`block rounded-md px-2 py-1.5 text-sm ${active ? "bg-row-hover" : "hover:bg-row-hover"}`}
    >
      <span className="block truncate text-ink">
        {match.in === "name" ? <Highlighted text={result.name} query={query} /> : result.name}
      </span>
      {match.in === "message" && (
        <span className="mt-0.5 line-clamp-2 block text-xs text-muted">
          {match.cutStart && "…"}
          <Highlighted text={match.snippet.replace(/\s+/g, " ")} query={query} />
          {match.cutEnd && "…"}
        </span>
      )}
    </a>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightSegments(text, query).map((piece, index) =>
        piece.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one string, in order.
          <mark key={index} className="rounded-sm bg-accent-tint text-ink">
            {piece.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one string, in order.
          <span key={index}>{piece.text}</span>
        ),
      )}
    </>
  );
}
