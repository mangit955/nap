import type { SessionSearchResult } from "@nap/shared/session-navigation";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SEARCH_DEBOUNCE_MS } from "../projects/use-session-search.ts";
import { Sidebar } from "./sidebar.tsx";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const named: SessionSearchResult = {
  projectId: "00000000-0000-4000-8000-000000000001",
  name: "Invoice tool",
  match: { in: "name" },
};
const said: SessionSearchResult = {
  projectId: "00000000-0000-4000-8000-000000000002",
  name: "Billing",
  match: {
    in: "message",
    snippet: "make the <b>invoice</b> total bold",
    cutStart: true,
    cutEnd: false,
    at: "2026-11-01T00:00:00.000Z",
  },
};

function mount() {
  const search = vi.fn(async () => ({ ok: true as const, value: { results: [named, said] } }));
  const onSelectProject = vi.fn();
  render(
    <Sidebar
      navigation={{
        projects: [],
        status: "ready",
        actionError: undefined,
        undoAction: undefined,
        apply: vi.fn(),
        change: vi.fn(),
        undo: vi.fn(),
        reload: vi.fn(),
        dismissUndo: vi.fn(),
        rename: vi.fn(),
        remove: vi.fn(),
        close: vi.fn(),
        search,
      }}
      name="Reader"
      email={undefined}
      recents={[]}
      keyHint={undefined}
      onNewProject={vi.fn()}
      onApiKey={vi.fn()}
      onSignOut={vi.fn()}
      onSelectProject={onSelectProject}
    />,
  );
  return {
    search,
    onSelectProject,
    box: screen.getByRole("combobox", { name: "Search sessions" }),
  };
}

it("lists what the server found, marks the match as text, and opens one from the keyboard", async () => {
  const { search, onSelectProject, box } = mount();
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: "invoice" } });
  expect(screen.getByRole("status")).toHaveTextContent("Searching…");
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(search).toHaveBeenCalledOnce();
  expect(search).toHaveBeenCalledWith("invoice", expect.any(AbortSignal));

  const listbox = screen.getByRole("listbox", { name: "Search results" });
  const options = within(listbox).getAllByRole("option");
  expect(options.map((option) => option.getAttribute("href"))).toEqual([
    `/p/${named.projectId}`,
    `/p/${said.projectId}`,
  ]);
  // The message's own markup is text, never elements.
  expect(options[1]).toHaveTextContent("…make the <b>invoice</b> total bold");
  expect(options[1]?.querySelector("b")).toBeNull();
  expect([...listbox.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([
    "Invoice",
    "invoice",
  ]);
  expect(box).toHaveAttribute("aria-expanded", "true");

  fireEvent.keyDown(box, { key: "ArrowDown" });
  fireEvent.keyDown(box, { key: "ArrowDown" });
  expect(box).toHaveAttribute("aria-activedescendant", options[1]?.id);
  expect(options[1]).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(box, { key: "ArrowDown" });
  expect(box).toHaveAttribute("aria-activedescendant", options[0]?.id);
  fireEvent.keyDown(box, { key: "ArrowUp" });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onSelectProject).toHaveBeenCalledExactlyOnceWith(said.projectId);
});

it("shows nothing until the query is long enough, and closes when the box loses focus", async () => {
  const { search, box } = mount();
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: "i" } });
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(search).not.toHaveBeenCalled();
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.change(box, { target: { value: "in" } });
  await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  fireEvent.blur(box);
  expect(screen.queryByRole("listbox")).toBeNull();
});
