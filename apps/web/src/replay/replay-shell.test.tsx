import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_TITLE } from "../components/preview-pane.tsx";
import { playbackOffsets } from "./playback.ts";
import type { ReplayRecording } from "./recording.ts";
import { ReplayShell } from "./replay-shell.tsx";
import { findReplay } from "./replays.ts";

// The real file panel and its cache; only the syntax highlighter is replaced.
vi.mock("next/dynamic", () => ({
  default:
    () =>
    ({ contents }: { contents: string }) => <pre>{contents}</pre>,
}));

function readingList(): ReplayRecording {
  const recording = findReplay("reading-list");
  if (!recording) throw new Error("the reading-list replay is missing");
  return recording;
}

/**
 * Every way a page can reach a server, each failing the test the moment it is used.
 *
 * This is the whole of the "free to watch" argument. A model is called and a sandbox started only
 * by the API, on a request from this page — a turn submitted over HTTP, or a socket opened to a
 * session's stream — so a replay that makes no request at all can do neither, whatever is
 * running behind the deployment. Thrown rather than counted, so a request the page swallowed
 * still fails below on the call count.
 */
const ways = {
  fetch: vi.fn(),
  WebSocket: vi.fn(),
  EventSource: vi.fn(),
  XMLHttpRequest: vi.fn(),
  sendBeacon: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  for (const [name, spy] of Object.entries(ways)) {
    spy.mockReset();
    spy.mockImplementation(() => {
      throw new Error(`a replay used ${name}`);
    });
    // jsdom has no `sendBeacon` to spy on, so one is put where a browser keeps it.
    if (name === "sendBeacon")
      Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: spy });
    else vi.stubGlobal(name, spy);
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function playToEnd(recording: ReplayRecording) {
  const end = playbackOffsets(recording.events).at(-1) ?? 0;
  act(() => {
    vi.advanceTimersByTime(end + 1000);
  });
}

function expectNoRequests() {
  for (const [name, spy] of Object.entries(ways)) expect(spy, name).not.toHaveBeenCalled();
}

describe("a replay", () => {
  it("starts with the prompt, as the person sent it", () => {
    const recording = readingList();
    render(<ReplayShell recording={recording} />);
    const prompt = recording.events[0];
    if (prompt?.type !== "user.message") throw new Error("a session starts with its prompt");
    const firstLine = prompt.payload.text.split("\n")[0] ?? "";
    expect(
      within(screen.getByRole("region", { name: "Conversation" })).getByText(firstLine, {
        exact: false,
      }),
    ).toBeInTheDocument();
  });

  it("plays to the end, verified, without a single request", () => {
    const recording = readingList();
    render(<ReplayShell recording={recording} />);
    playToEnd(recording);

    expect(screen.getByRole("status", { name: "Job phase" })).toHaveTextContent("Verified");
    expect(screen.getByRole("button", { name: /watch again/i })).toBeInTheDocument();
    expect(screen.getByText(/type checking and production build both pass/i)).toBeInTheDocument();
    // Nothing on the page offers to do anything: there is nobody to do it for.
    expect(screen.queryByRole("region", { name: "Test the app" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expectNoRequests();
  });

  it("shows the app it built from this deployment's own files, never the sandbox's address", () => {
    const recording = readingList();
    render(<ReplayShell recording={recording} />);
    playToEnd(recording);

    const frame = screen.getByTitle(PREVIEW_TITLE);
    const src = new URL(frame.getAttribute("src") ?? "");
    expect(src.origin).toBe(window.location.origin);
    expect(src.pathname).toBe(recording.builds.at(-1)?.path);
    expect(document.body.innerHTML).not.toContain("e2b.app");
  });

  it("opens the agent's file as it stood, from the recording", async () => {
    const recording = readingList();
    render(<ReplayShell recording={recording} />);
    playToEnd(recording);

    const panel = screen.getByRole("region", { name: "Right panel" });
    fireEvent.click(within(panel).getByRole("tab", { name: /^files$/i }));
    fireEvent.click(within(panel).getByRole("button", { name: /^App\.tsx/ }));
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    const last = recording.revisions.at(-1);
    expect(
      screen.getByRole("region", { name: "src/App.tsx (read-only)" }).querySelector("pre"),
    ).toHaveTextContent((last?.contents ?? "").slice(0, 40));
    expectNoRequests();
  });

  it("can skip to the end and be watched again", () => {
    const recording = readingList();
    render(<ReplayShell recording={recording} />);
    fireEvent.click(screen.getByRole("button", { name: /skip to the end/i }));
    expect(screen.getByRole("status", { name: "Job phase" })).toHaveTextContent("Verified");

    fireEvent.click(screen.getByRole("button", { name: /watch again/i }));
    expect(screen.queryByText(/type checking and production build both pass/i)).toBeNull();
    playToEnd(recording);
    expect(screen.getByText(/type checking and production build both pass/i)).toBeInTheDocument();
    expectNoRequests();
  });

  it("leaves the panel alone once the visitor has closed it", () => {
    const recording = readingList();
    render(<ReplayShell recording={recording} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide right panel" }));
    playToEnd(recording);
    // Following the session would have reopened it twice: for the file, then for the app.
    expect(screen.getByRole("button", { name: "Show right panel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hide right panel" })).toBeNull();
  });

  it("picks up where it paused, not where the clock has got to", () => {
    const recording = readingList();
    render(<ReplayShell recording={recording} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.click(screen.getByRole("button", { name: /pause/i }));
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    fireEvent.click(screen.getByRole("button", { name: /resume/i }));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // Two seconds of playback in, the reply that ends the session is half a minute away.
    expect(screen.queryByText(/type checking and production build both pass/i)).toBeNull();
    playToEnd(recording);
    expect(screen.getByText(/type checking and production build both pass/i)).toBeInTheDocument();
  });

  it("holds still while paused", () => {
    const recording = readingList();
    render(<ReplayShell recording={recording} />);
    fireEvent.click(screen.getByRole("button", { name: /pause/i }));
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();
    expect(screen.queryByText(/type checking and production build both pass/i)).toBeNull();
  });
});
