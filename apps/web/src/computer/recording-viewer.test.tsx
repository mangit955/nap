import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type RecordingView, RecordingViewer } from "./recording-viewer.tsx";

const recording: RecordingView = {
  title: "Save a note",
  videoUrl: "/sessions/owner/test-recordings/42",
  counts: { passed: 1, failed: 1, untested: 1 },
  annotations: [
    { timeMs: 0, annotation: { type: "setup", description: "Open the notes app" } },
    { timeMs: 2000, annotation: { type: "test_start", id: "save", description: "Save note" } },
    {
      timeMs: 2200,
      annotation: {
        type: "assertion",
        id: "saved",
        expectation: "The note appears",
        result: "untested",
      },
    },
    {
      timeMs: 4000,
      annotation: {
        type: "assertion",
        id: "saved",
        expectation: "The note appears",
        result: "passed",
      },
    },
    { timeMs: 5000, annotation: { type: "test_start", id: "delete", description: "Delete note" } },
    {
      timeMs: 6000,
      annotation: {
        type: "assertion",
        id: "removed",
        expectation: "The note disappears",
        result: "failed",
      },
    },
    {
      timeMs: 6500,
      annotation: {
        type: "assertion",
        id: "retry",
        expectation: "Undo restores the note",
        result: "untested",
      },
    },
  ],
};

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
    this.dispatchEvent(new Event("pause"));
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function video() {
  const element = screen.getByLabelText("Test recording");
  if (!(element instanceof HTMLVideoElement)) throw new Error("Expected native video");
  return element;
}
function metadata() {
  Object.defineProperty(video(), "duration", { configurable: true, value: 8 });
  Object.defineProperty(video(), "readyState", { configurable: true, value: 1 });
  fireEvent.loadedMetadata(video());
}

it("renders the empty view with an accessible close and restores focus", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const close = vi.fn();
  const view = render(<RecordingViewer recording={null} onClose={close} />);
  expect(screen.getByRole("dialog", { name: "Test recording viewer" })).toHaveAttribute(
    "aria-modal",
    "true",
  );
  expect(screen.getByText("No browser test recordings in this session yet")).toBeVisible();
  const button = screen.getByRole("button", { name: "Close test recording viewer" });
  expect(button).toHaveFocus();
  fireEvent.click(button);
  expect(close).toHaveBeenCalledOnce();
  view.unmount();
  expect(opener).toHaveFocus();
  opener.remove();
});

it("renders counts, ordered chapters, latest assertion verdicts and the owner download URL", () => {
  render(<RecordingViewer recording={recording} onClose={vi.fn()} />);
  expect(screen.getByRole("heading", { name: recording.title })).toBeVisible();
  for (const name of ["Passed 1", "Failed 1", "Untested 1"])
    expect(screen.getByText(name)).toBeVisible();
  const rail = screen.getByRole("navigation", { name: "Recording chapters" });
  expect(
    within(rail)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual([
    expect.stringContaining("Setup"),
    expect.stringContaining("Save note"),
    expect.stringContaining("Delete note"),
  ]);
  expect(within(rail).getByRole("button", { name: /Save note/ })).toHaveTextContent("passed");
  expect(within(rail).getByRole("button", { name: /Delete note/ })).toHaveTextContent("failed");
  expect(screen.getByRole("link", { name: "Download recording" })).toHaveAttribute(
    "href",
    recording.videoUrl,
  );
  expect(video()).toHaveAttribute("crossorigin", "use-credentials");
  expect(video().muted).toBe(true);
  expect(screen.queryByRole("button", { name: /audio|mute|DOM replay/i })).not.toBeInTheDocument();
});

it("seeks chapters, keeps declarations paired with final results and loops only the chosen chapter", async () => {
  render(<RecordingViewer recording={recording} onClose={vi.fn()} />);
  metadata();
  fireEvent.click(screen.getByRole("button", { name: /Test 1.*Save note/ }));
  expect(video().currentTime).toBe(2);
  const detail = screen.getByRole("region", { name: "Current chapter" });
  expect(within(detail).getByText("The note appears")).toBeVisible();
  expect(within(detail).getAllByText("passed")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Loop current chapter" }));
  video().currentTime = 5.1;
  fireEvent.timeUpdate(video());
  expect(video().currentTime).toBe(2);
  fireEvent.click(screen.getByRole("button", { name: "Next chapter" }));
  expect(video().currentTime).toBe(5);
  video().currentTime = 8;
  fireEvent.ended(video());
  expect(video().currentTime).toBe(5);
  await act(async () => {});
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
});

it("updates playback from native events, supports scoped shortcuts, speed and seeking", async () => {
  render(<RecordingViewer recording={recording} onClose={vi.fn()} />);
  metadata();
  const dialog = screen.getByRole("dialog");
  fireEvent.keyDown(dialog, { key: " ", code: "Space" });
  await act(async () => {});
  expect(screen.getByRole("button", { name: "Pause recording" })).toBeVisible();
  fireEvent.pause(video());
  expect(screen.getByRole("button", { name: "Play recording" })).toBeVisible();
  fireEvent.keyDown(dialog, { key: "ArrowRight", shiftKey: true });
  expect(video().currentTime).toBe(2);
  fireEvent.keyDown(screen.getByRole("button", { name: /Test 1.*Save note/ }), {
    key: "ArrowLeft",
    shiftKey: true,
  });
  expect(video().currentTime).toBe(0);
  const speed = screen.getByRole("combobox", { name: "Playback speed" });
  fireEvent.change(speed, { target: { value: "1.5" } });
  expect(video().playbackRate).toBe(1.5);
  fireEvent.keyDown(speed, { key: " ", code: "Space" });
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole("slider", { name: "Recording position" }), {
    target: { value: "6" },
  });
  expect(video().currentTime).toBe(6);
  expect(screen.getByRole("button", { name: /Delete note/ })).toHaveAttribute(
    "aria-current",
    "step",
  );
});

it("traps focus, handles Escape and removes keyboard/media work on unmount", () => {
  const close = vi.fn();
  const view = render(<RecordingViewer recording={recording} onClose={close} />);
  metadata();
  const dialog = screen.getByRole("dialog");
  const first = screen.getByRole("button", { name: "Close test recording viewer" });
  const last = screen.getByRole("link", { name: "Download recording" });
  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(last).toHaveFocus();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
  const oldVideo = video();
  const remove = vi.spyOn(oldVideo, "removeEventListener");
  const removeKeyboard = vi.spyOn(dialog, "removeEventListener");
  view.unmount();
  expect(remove.mock.calls.map(([type]) => type)).toEqual(
    expect.arrayContaining(["timeupdate", "play", "pause", "ended", "error", "loadedmetadata"]),
  );
  expect(removeKeyboard).toHaveBeenCalledWith("keydown", expect.any(Function));
  fireEvent.keyDown(document, { key: " ", code: "Space" });
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
});

it("resets a replaced source and ignores late native events and rejected play promises", async () => {
  let rejectPlay: (reason: Error) => void = () => {};
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectPlay = reject;
      }),
  );
  const view = render(<RecordingViewer recording={recording} onClose={vi.fn()} />);
  metadata();
  const oldVideo = video();
  fireEvent.click(screen.getByRole("button", { name: "Play recording" }));
  view.rerender(
    <RecordingViewer
      recording={{
        ...recording,
        videoUrl: "/sessions/owner/test-recordings/43",
        title: "Second recording",
      }}
      onClose={vi.fn()}
    />,
  );
  expect(video()).not.toBe(oldVideo);
  expect(screen.getByRole("button", { name: "Play recording" })).toBeDisabled();
  fireEvent.error(oldVideo);
  fireEvent.play(oldVideo);
  await act(async () => rejectPlay(new Error("old source")));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  metadata();
  expect(screen.getByRole("button", { name: "Play recording" })).toBeEnabled();
  fireEvent.error(video());
  expect(screen.getByRole("alert")).toHaveTextContent("This recording could not be loaded");
  expect(screen.getByRole("button", { name: "Play recording" })).toBeDisabled();
});

it("shows playback rejection and works with no test chapters", async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error("blocked"));
  render(<RecordingViewer recording={{ ...recording, annotations: [] }} onClose={vi.fn()} />);
  metadata();
  expect(screen.getByRole("button", { name: "Next chapter" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Previous chapter" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Play recording" }));
  await act(async () => {});
  expect(screen.getByRole("alert")).toHaveTextContent("Playback could not start");
  expect(screen.getByRole("button", { name: "Play recording" })).toBeEnabled();
});

it("requests fullscreen on the native video and reports fullscreen rejection", async () => {
  render(<RecordingViewer recording={recording} onClose={vi.fn()} />);
  const request = vi
    .fn<() => Promise<void>>()
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("denied"));
  Object.defineProperty(video(), "requestFullscreen", { configurable: true, value: request });
  metadata();
  fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
  await act(async () => {});
  expect(request).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
  await act(async () => {});
  expect(screen.getByRole("alert")).toHaveTextContent("Full screen is unavailable");
});
