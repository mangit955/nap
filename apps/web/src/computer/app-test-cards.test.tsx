import type { StoredEvent } from "@nap/shared/ports/event-store";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AppTestCards, AppTestResult } from "./app-test-cards.tsx";

import { foldAppTests } from "./app-test-state.ts";
import { ComputerNavigation } from "./navigation.tsx";
import { RecordingNavigation } from "./recording-navigation.tsx";

const base = { sessionId: "s", turnId: "t", createdAt: "2026-10-24T00:00:00Z" };
const verified: StoredEvent[] = [
  { ...base, seq: 1, type: "job.started", payload: { jobId: "job", objective: "Save notes" } },
  {
    ...base,
    seq: 2,
    type: "turn.completed",
    payload: { commitSha: "abcdef1", usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 0 },
  },
  { ...base, seq: 3, type: "job.checkpointed", payload: { jobId: "job", commitSha: "abcdef1" } },
  { ...base, seq: 4, type: "job.completed", payload: { jobId: "job", outcome: "verified" } },
];
const result: StoredEvent[] = [
  {
    ...base,
    seq: 5,
    type: "test.started",
    payload: { jobId: "job", commitSha: "abcdef1", objective: "Save notes" },
  },
  {
    ...base,
    seq: 6,
    type: "test.annotation",
    payload: {
      annotation: {
        type: "assertion",
        id: "save",
        expectation: "The saved note appears",
        result: "failed",
      },
      timeMs: 1000,
    },
  },
  {
    ...base,
    seq: 7,
    type: "test.completed",
    payload: { jobId: "job", status: "completed", counts: { passed: 0, failed: 1, untested: 0 } },
  },
];

it("opens the live computer when app testing is requested", () => {
  const seek = vi.fn();
  const test = vi.fn();
  render(
    <ComputerNavigation.Provider value={seek}>
      <AppTestCards
        events={verified}
        running={false}
        model="anthropic/claude-sonnet-5"
        onTest={test}
      />
    </ComputerNavigation.Provider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Test the app" }));
  expect(seek).toHaveBeenCalledWith(null);
  expect(test).toHaveBeenCalledWith("job");
});

it("opens only a completed available recording by turn identity", () => {
  const test = foldAppTests(result)[0]!;
  const watch = vi.fn();
  const available = {
    state: "available",
    key: "private-key",
    durationMs: 1000,
    width: 1024,
    height: 768,
    interrupted: false,
  } as const;
  const view = render(
    <RecordingNavigation.Provider value={watch}>
      <AppTestResult test={{ ...test, recording: available }} running={false} />
    </RecordingNavigation.Provider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Watch recording" }));
  expect(watch).toHaveBeenCalledWith(test.turnId);
  expect(document.body.textContent).not.toContain("private-key");
  view.rerender(
    <RecordingNavigation.Provider value={watch}>
      <AppTestResult test={{ ...test, status: "running", recording: available }} running />
    </RecordingNavigation.Provider>,
  );
  expect(screen.getByRole("button", { name: "Watch recording" })).toBeDisabled();
  view.rerender(
    <RecordingNavigation.Provider value={watch}>
      <AppTestResult
        test={{ ...test, recording: { state: "unavailable", reason: "capture_failed" } }}
        running={false}
      />
    </RecordingNavigation.Provider>,
  );
  expect(screen.getByRole("button", { name: "Watch recording" })).toBeDisabled();
});
it("offers app testing only after the latest completed job and respects busy/model states", () => {
  const onTest = vi.fn();
  const view = render(
    <AppTestCards
      events={verified.slice(0, 3)}
      running={false}
      model="anthropic/claude-sonnet-5"
      onTest={onTest}
    />,
  );
  expect(screen.queryByRole("button", { name: "Test the app" })).not.toBeInTheDocument();
  view.rerender(
    <AppTestCards
      events={verified}
      running={false}
      model="anthropic/claude-sonnet-5"
      onTest={onTest}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Test the app" }));
  expect(onTest).toHaveBeenCalledWith("job");
  view.rerender(
    <AppTestCards events={verified} running model="anthropic/claude-sonnet-5" onTest={onTest} />,
  );
  expect(screen.getByRole("button", { name: "Test the app" })).toBeDisabled();
  expect(screen.getByText(/Wait for the current turn/)).toBeInTheDocument();
  view.rerender(
    <AppTestCards
      events={verified}
      running={false}
      model="openai/gpt-oss-20b:free"
      onTest={onTest}
    />,
  );
  expect(screen.getByRole("button", { name: "Test the app" })).toBeDisabled();
});
it("keeps a failed assertion as data until Fix it is clicked and labels unavailable recordings", () => {
  const fix = vi.fn();
  render(<AppTestResult test={foldAppTests(result)[0]!} running={false} onFix={fix} />);
  const card = screen.getByRole("region", { name: "App test results" });
  expect(within(card).getByText("Failed 1")).toBeInTheDocument();
  expect(within(card).getByText("The saved note appears")).toBeInTheDocument();
  expect(within(card).getByRole("button", { name: "Watch recording" })).toBeDisabled();
  expect(fix).not.toHaveBeenCalled();
  fireEvent.click(within(card).getByRole("button", { name: "Fix it" }));
  expect(fix).toHaveBeenCalledWith(expect.stringContaining("The saved note appears"));
});
it("shows an honest empty assertion result and disables repair while another turn runs", () => {
  const view = render(<AppTestResult test={foldAppTests(result.slice(0, 1))[0]!} running />);
  expect(screen.getByText("Testing the app…")).toBeInTheDocument();
  view.rerender(
    <AppTestResult
      test={{
        ...foldAppTests(result)[0]!,
        status: "interrupted",
        assertions: [],
        counts: { passed: 0, failed: 0, untested: 0 },
      }}
      running={false}
    />,
  );
  expect(screen.getByText("No assertions were recorded.")).toBeInTheDocument();
  expect(screen.getByText("Test interrupted")).toBeInTheDocument();
  view.rerender(<AppTestResult test={foldAppTests(result)[0]!} running onFix={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Fix it" })).toBeDisabled();
});
