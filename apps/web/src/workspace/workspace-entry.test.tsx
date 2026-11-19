import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginStart,
  forgetWorkspaceEntry,
  openProject,
  PREFETCH_EVERY_MS,
  startInFlight,
  takeStartFailure,
  usePrefetchWorkspace,
  useWorkspaceEntry,
} from "./workspace-entry.ts";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/p/new",
}));

afterEach(() => {
  forgetWorkspaceEntry();
  replace.mockClear();
  vi.useRealTimers();
});

const push = () => ({ push: vi.fn() });

/** What the workspace at `/p/new` is told. */
function Probe() {
  const entry = useWorkspaceEntry();
  return (
    <output aria-label="Workspace entry">
      {entry.projectId ?? (entry.starting ? `starting: ${entry.starting.text}` : "")}
    </output>
  );
}
const shown = () => screen.getByRole("status", { name: "Workspace entry" });

describe("a start's answer", () => {
  it("is nobody's once a later way in has replaced it", () => {
    const start = beginStart(push(), { ownerId: "owner", prompt: { text: "First" } });
    // Back to the dashboard mid-start, and a row opened from there.
    openProject(push(), "project-b");
    render(<Probe />);

    act(() => start.started("project-a"));
    expect(shown()).toHaveTextContent("project-b");

    act(() => start.failed("Refused"));
    expect(takeStartFailure("owner")).toBeUndefined();
  });

  it("is nobody's after sign-out, so the signed-out person's prompt never comes back", () => {
    const start = beginStart(push(), { ownerId: "owner", prompt: { text: "Private" } });
    forgetWorkspaceEntry();
    render(<Probe />);

    act(() => start.failed("Refused"));
    expect(takeStartFailure("owner")).toBeUndefined();
    expect(shown()).toHaveTextContent("");
  });
});

describe("a failed start's reason", () => {
  it("goes to the person who started it, once", () => {
    beginStart(push(), { ownerId: "owner", prompt: { text: "Too many" } }).failed("Refused");

    expect(takeStartFailure("someone-else")).toBeUndefined();
    expect(takeStartFailure("owner")).toBe("Refused");
    expect(takeStartFailure("owner")).toBeUndefined();
  });
});

describe("a start in flight", () => {
  it("is this person's to wait on until it is over", async () => {
    const start = beginStart(push(), { ownerId: "owner", prompt: { text: "Wait" } });

    expect(startInFlight("someone-else")).toBeUndefined();
    const inFlight = startInFlight("owner");
    expect(inFlight).toBeInstanceOf(Promise);

    start.started("project-a");
    await expect(inFlight).resolves.toBeUndefined();
    expect(startInFlight("owner")).toBeUndefined();
  });
});

describe("keeping the entry page prefetched", () => {
  function Prefetcher({ prefetch }: { prefetch: (href: string) => void }) {
    usePrefetchWorkspace({ prefetch });
    return null;
  }

  it("asks on mount, then again on activity once the last ask is old", () => {
    vi.useFakeTimers();
    const prefetch = vi.fn();
    render(<Prefetcher prefetch={prefetch} />);
    expect(prefetch.mock.calls).toEqual([["/p/new"]]);

    document.dispatchEvent(new Event("pointerover"));
    expect(prefetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PREFETCH_EVERY_MS);
    document.dispatchEvent(new Event("pointerover"));
    expect(prefetch).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(PREFETCH_EVERY_MS);
    document.body.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(prefetch).toHaveBeenCalledTimes(3);

    // Typing into a box that already has focus.
    vi.advanceTimersByTime(PREFETCH_EVERY_MS);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
    expect(prefetch).toHaveBeenCalledTimes(4);
  });
});
