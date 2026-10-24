import type { NapEventOf } from "@nap/shared/events";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ChatTranscript } from "../chat/chat-transcript.tsx";
import { WorkEntryBody } from "../chat/tool-body.tsx";
import { buildTranscript, type TranscriptItem } from "../chat/transcript.ts";
import { WorkEntryRow } from "../chat/work-log-rows.tsx";
import { ComputerNavigation } from "./navigation.tsx";

const frame: NapEventOf<"computer.screenshot"> = {
  type: "computer.screenshot",
  sessionId: "s",
  turnId: "t",
  seq: 3,
  createdAt: "2026-10-24T00:00:00Z",
  payload: { toolCallId: "screen", key: "private", width: 1024, height: 768 },
};
const entry: Extract<TranscriptItem, { kind: "step" }> = {
  kind: "step",
  key: 1,
  at: frame.createdAt,
  toolCallId: "screen",
  toolName: "computer",
  status: "ok",
  input: {
    actions: [
      { action: "left_click", coordinate: [512, 384] },
      { action: "type", text: "private-value" },
    ],
  },
  output: "Completed",
  streamed: "",
  files: [],
  frame,
};
it("seeks the same frame from the computer row and each action without exposing typed values", () => {
  const seek = vi.fn();
  render(
    <ComputerNavigation.Provider value={seek}>
      <WorkEntryRow entry={entry} />
    </ComputerNavigation.Provider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Used computer - 2 actions" }));
  expect(seek).toHaveBeenCalledWith(3);
  fireEvent.click(screen.getByRole("button", { name: "Typed text" }));
  expect(seek).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/private-value/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Clicked at (512, 384)" })).toBeInTheDocument();
});
it("opens a transcript screenshot card even when its call was outside the replay window", () => {
  const seek = vi.fn();
  render(
    <ComputerNavigation.Provider value={seek}>
      <ChatTranscript items={buildTranscript([frame])} />
    </ComputerNavigation.Provider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open computer screenshot" }));
  expect(seek).toHaveBeenCalledWith(3);
  expect(screen.getByRole("img", { name: "Computer screenshot" })).toHaveAttribute(
    "crossorigin",
    "use-credentials",
  );
});
it("shows the desktop timer only while startup is pending", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T00:00:10Z"));
  const pending = {
    ...entry,
    status: "running" as const,
    desktop: { state: "starting" as const, at: new Date(Date.now() - 10000).toISOString() },
  };
  const view = render(<WorkEntryBody entry={pending} />);
  expect(screen.getByRole("status")).toHaveTextContent(/Waiting for desktop to be ready \(10s\)/);
  view.rerender(
    <WorkEntryBody entry={{ ...pending, desktop: { state: "ready", at: frame.createdAt } }} />,
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  vi.useRealTimers();
});

it("attaches frames and startup to their own call across interleaved tools", () => {
  const events: NapEventOf<"tool.call">[] = ["screen", "other"].map((toolCallId, index) => ({
    ...frame,
    seq: index + 1,
    type: "tool.call",
    payload: { toolCallId, toolName: "computer", input: { actions: [{ action: "screenshot" }] } },
  }));
  const items = buildTranscript([
    ...events,
    {
      ...frame,
      seq: 3,
      type: "computer.status",
      payload: { toolCallId: "screen", state: "starting" },
    },
    { ...frame, seq: 4 },
  ]);
  const steps = items.filter((item) => item.kind === "step");
  expect(steps[0]?.frame?.seq).toBe(4);
  expect(steps[0]?.desktop?.state).toBe("starting");
  expect(steps[1]?.frame).toBeUndefined();
  expect(steps[1]?.desktop).toBeUndefined();
  expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
});
