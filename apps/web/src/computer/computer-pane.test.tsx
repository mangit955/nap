import type { StoredEvent } from "@nap/shared/ports/event-store";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ComputerPane } from "./computer-pane.tsx";

const frame: StoredEvent = {
  type: "computer.screenshot",
  sessionId: "session",
  turnId: "turn",
  seq: 3,
  createdAt: "2026-10-24T00:00:00Z",
  payload: { toolCallId: "screen", key: "private-key", width: 1024, height: 768 },
};
it("shows a named computer with a private screenshot and navigable history controls", () => {
  const seek = vi.fn();
  render(<ComputerPane events={[frame, { ...frame, seq: 6 }]} selectedSeq={null} onSeek={seek} />);
  expect(screen.getByRole("application", { name: "Remote computer" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Computer screenshot" })).toHaveAttribute(
    "crossorigin",
    "use-credentials",
  );
  expect(screen.getByRole("img", { name: "Computer screenshot" }).getAttribute("src")).toContain(
    "/sessions/session/computer/screenshots/6",
  );
  expect(screen.getByRole("slider", { name: "Session timeline" })).toHaveValue("6");
  fireEvent.click(screen.getByRole("button", { name: "Previous event" }));
  expect(seek).toHaveBeenLastCalledWith(3);
  expect(screen.getByRole("combobox", { name: "Stream quality" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Full screen" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open computer in new window" })).toBeInTheDocument();
});
it("returns from history to following the latest screenshot", () => {
  const seek = vi.fn();
  render(<ComputerPane events={[frame, { ...frame, seq: 6 }]} selectedSeq={3} onSeek={seek} />);
  fireEvent.click(screen.getByRole("button", { name: "Go to live desktop" }));
  expect(seek).toHaveBeenCalledWith(null);
  fireEvent.click(screen.getByRole("button", { name: "Next event" }));
  expect(seek).toHaveBeenCalledWith(6);
});
it("distinguishes a waiting computer from a missing historical frame", () => {
  const view = render(<ComputerPane events={[]} selectedSeq={null} onSeek={() => {}} />);
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for Nap's computer…");
  view.rerender(<ComputerPane events={[frame]} selectedSeq={0} onSeek={() => {}} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "No screenshot is available at this point in history.",
  );
});
it("shows loading and retry states without allowing stale image loads to settle a newer frame", () => {
  const view = render(<ComputerPane events={[frame]} selectedSeq={null} onSeek={() => {}} />);
  const old = screen.getByRole("img", { name: "Computer screenshot" });
  expect(screen.getByRole("status")).toHaveTextContent("Connecting to Nap's computer…");
  view.rerender(
    <ComputerPane events={[frame, { ...frame, seq: 6 }]} selectedSeq={null} onSeek={() => {}} />,
  );
  fireEvent.load(old);
  expect(screen.getByRole("status")).toHaveTextContent("Connecting to Nap's computer…");
  fireEvent.error(screen.getByRole("img", { name: "Computer screenshot" }));
  expect(screen.getByRole("status")).toHaveTextContent("Failed to connect to Nap's computer");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  fireEvent.load(screen.getByRole("img", { name: "Computer screenshot" }));
  expect(screen.queryByText("Failed to connect to Nap's computer")).not.toBeInTheDocument();
});

it("recognizes an image that finished before hydration attached its load listener", () => {
  const complete = vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  const width = vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(1024);
  try {
    render(<ComputerPane events={[frame]} selectedSeq={null} onSeek={() => {}} />);
    expect(screen.queryByText("Connecting to Nap's computer…")).not.toBeInTheDocument();
  } finally {
    complete.mockRestore();
    width.mockRestore();
  }
});
