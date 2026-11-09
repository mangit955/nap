import type { SessionSearchResult } from "@nap/shared/session-navigation";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  highlightSegments,
  SEARCH_DEBOUNCE_MS,
  type SearchSessions,
  useSessionSearch,
} from "./use-session-search.ts";

const hit = (name: string): SessionSearchResult => ({
  projectId: crypto.randomUUID(),
  name,
  match: { in: "name" },
});

/** A search whose answers the test releases, in whatever order it likes. */
function controlledSearch() {
  const calls: {
    query: string;
    signal: AbortSignal;
    answer: (results: SessionSearchResult[]) => void;
  }[] = [];
  const search: SearchSessions = (query, signal) =>
    new Promise((resolve) => {
      calls.push({
        query,
        signal,
        answer: (results) => resolve({ ok: true, value: { results } }),
      });
    });
  return { search, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useSessionSearch", () => {
  it("sends nothing below the minimum or without a way to search", async () => {
    const { search, calls } = controlledSearch();
    const { result, rerender } = renderHook(({ q, s }) => useSessionSearch(q, s), {
      initialProps: { q: "ab", s: search as SearchSessions | undefined },
    });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2));
    expect(result.current).toEqual({ status: "idle" });
    rerender({ q: "abc", s: undefined });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2));
    expect(calls).toEqual([]);
  });

  it("waits for typing to pause and sends the trimmed query once", async () => {
    const { search, calls } = controlledSearch();
    const { result, rerender } = renderHook(({ q }) => useSessionSearch(q, search), {
      initialProps: { q: "in" },
    });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 50));
    rerender({ q: "inv" });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 50));
    rerender({ q: " invoice " });
    expect(calls).toEqual([]);
    expect(result.current).toEqual({ status: "loading", query: "invoice" });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(calls.map((call) => call.query)).toEqual(["invoice"]);
    const found = [hit("Invoice tool")];
    await act(async () => calls[0]?.answer(found));
    expect(result.current).toEqual({ status: "ready", query: "invoice", results: found });
  });

  it("never lets an older answer replace a newer one", async () => {
    const { search, calls } = controlledSearch();
    const { result, rerender } = renderHook(({ q }) => useSessionSearch(q, search), {
      initialProps: { q: "old" },
    });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    rerender({ q: "newer" });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    const [older, newer] = calls;
    expect(older?.signal.aborted).toBe(true);
    const fresh = [hit("Newer")];
    await act(async () => newer?.answer(fresh));
    await act(async () => older?.answer([hit("Old")]));
    expect(result.current).toEqual({ status: "ready", query: "newer", results: fresh });
  });

  it("reports a refusal as an error for that query", async () => {
    const search: SearchSessions = async () => ({ ok: false, error: "Search failed." });
    const { result } = renderHook(() => useSessionSearch("menu", search));
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(result.current).toEqual({ status: "error", query: "menu", error: "Search failed." });
  });
});

describe("highlightSegments", () => {
  it("marks every match whatever its case, and takes the query literally", () => {
    expect(highlightSegments("Make the Button, then a button.", "button")).toEqual([
      { text: "Make the ", match: false },
      { text: "Button", match: true },
      { text: ", then a ", match: false },
      { text: "button", match: true },
      { text: ".", match: false },
    ]);
    expect(highlightSegments("costs $5.00 (approx)", "$5.00 (")).toEqual([
      { text: "costs ", match: false },
      { text: "$5.00 (", match: true },
      { text: "approx)", match: false },
    ]);
    expect(highlightSegments("<b>bold</b>", "bold")).toEqual([
      { text: "<b>", match: false },
      { text: "bold", match: true },
      { text: "</b>", match: false },
    ]);
  });

  it("matches a query's spaces against the snippet's, however many either has", () => {
    // The server matched "blue  button" with its two spaces; the snippet is drawn with one.
    expect(highlightSegments("make the blue button", "blue \t button")).toEqual([
      { text: "make the ", match: false },
      { text: "blue button", match: true },
    ]);
  });
});
