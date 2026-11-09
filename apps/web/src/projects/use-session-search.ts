import {
  SESSION_SEARCH_MAX,
  SESSION_SEARCH_MIN,
  type SessionSearchResult,
} from "@nap/shared/session-navigation";
import { useEffect, useState } from "react";

/** One request to `GET /sessions/search`, answered as a value; never throws. */
export type SearchSessions = (
  query: string,
  signal: AbortSignal,
) => Promise<
  { ok: true; value: { results: SessionSearchResult[] } } | { ok: false; error: string }
>;

export type SessionSearchState =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | { status: "ready"; query: string; results: SessionSearchResult[] }
  | { status: "error"; query: string; error: string };

/** How long typing has to pause before a search is sent. */
export const SEARCH_DEBOUNCE_MS = 250;

/**
 * The sidebar's message search, as typed.
 *
 * Waits for typing to pause, then sends one request; a new keystroke aborts the request in flight
 * and drops whatever it answers, so an older, slower response can never replace a newer one.
 * Below the server's minimum, or with no way to search, it is idle and sends nothing.
 */
export function useSessionSearch(
  query: string,
  search: SearchSessions | undefined,
  delayMs = SEARCH_DEBOUNCE_MS,
): SessionSearchState {
  const [state, setState] = useState<SessionSearchState>({ status: "idle" });
  const trimmed = query.trim();
  const searchable =
    search !== undefined &&
    trimmed.length >= SESSION_SEARCH_MIN &&
    trimmed.length <= SESSION_SEARCH_MAX;

  useEffect(() => {
    if (!searchable || search === undefined) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading", query: trimmed });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void search(trimmed, controller.signal).then((result) => {
        // Aborted means a newer query owns the state now.
        if (controller.signal.aborted) return;
        setState(
          result.ok
            ? { status: "ready", query: trimmed, results: result.value.results }
            : { status: "error", query: trimmed, error: result.error },
        );
      });
    }, delayMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchable, search, trimmed, delayMs]);

  return searchable ? state : { status: "idle" };
}

/**
 * `text` cut into the pieces that match `query` and the pieces between, compared without regard to
 * case, for drawing as text and `<mark>` — never as HTML.
 */
export function highlightSegments(text: string, query: string): { text: string; match: boolean }[] {
  const needle = query.trim();
  if (needle === "") return [{ text, match: false }];
  const pattern = new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "giu");
  return text
    .split(pattern)
    .map((piece, index) => ({ text: piece, match: index % 2 === 1 }))
    .filter((piece) => piece.text !== "");
}
