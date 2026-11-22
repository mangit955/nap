"use client";

import { appTestTarget } from "@nap/shared/app-testing";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { MonitorPlay } from "lucide-react";
import { use, useId } from "react";
import type { TurnSubmission } from "../chat/use-turn-submission.ts";
import { type AppTestState, appTestRepairPrompt } from "./app-test-state.ts";
import { ComputerNavigation } from "./navigation.tsx";
import { RecordingNavigation } from "./recording-navigation.tsx";

export function AppTestCards({
  events,
  running,
  testPhase = "idle",
  images,
  onTest,
}: {
  events: readonly StoredEvent[];
  running: boolean;
  testPhase?: TurnSubmission["testPhase"];
  /** Whether the model a test would run on can see the screenshots it is made of. */
  images: boolean;
  onTest?: ((jobId: string) => void) | undefined;
}) {
  const openComputer = use(ComputerNavigation);
  const line = useId();
  const target = appTestTarget(events);
  const reason = running
    ? "Wait for the current turn to finish."
    : !images
      ? "Choose a model that can view images."
      : !onTest
        ? "Computer tests are unavailable."
        : null;
  if (!target) return null;
  const progress =
    testPhase === "starting"
      ? "Starting app test…"
      : testPhase === "running"
        ? "Testing the app…"
        : null;
  return (
    <div className="mx-auto max-w-[46rem] px-5 pb-4">
      {/*
        One line in the changed-files card's style: an offer, not a result. It keeps one shape in
        every state. The sentence says why a test cannot run, and the button stays in place,
        disabled, so the action is still there to find.
      */}
      <section
        aria-label="Test the app"
        className="flex items-center gap-2.5 rounded-lg bg-field py-2 pr-2 pl-3"
      >
        <MonitorPlay aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
        {progress ? (
          <p
            id={line}
            role="status"
            aria-label="App test progress"
            className="min-w-0 flex-1 text-ink-2 text-xs"
          >
            {progress} The plan, computer actions and results will appear in this conversation.
          </p>
        ) : (
          <p id={line} className="min-w-0 flex-1 text-muted text-xs">
            {reason ?? "Let Nap try the most important flow in its computer."}
          </p>
        )}
        <button
          type="button"
          aria-describedby={line}
          disabled={reason !== null || progress !== null}
          onClick={() => {
            openComputer?.(null);
            onTest?.(target.jobId);
          }}
          className="h-6 shrink-0 rounded-md bg-accent px-2.5 font-medium text-white text-xs transition-colors enabled:cursor-pointer enabled:hover:bg-accent/90 disabled:bg-hover disabled:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Test the app
        </button>
      </section>
    </div>
  );
}

export function AppTestResult({
  test,
  running,
  onFix,
}: {
  test: AppTestState;
  running: boolean;
  /** Sends the repair prompt, naming this test so the job it opens keeps the test's goal. */
  onFix?: ((message: string, testTurnId: string) => void) | undefined;
}) {
  const watch = use(RecordingNavigation);
  const playable = test.status !== "running" && test.recording.state === "available" && !!watch;
  const repair = appTestRepairPrompt(test);
  const total = test.counts.passed + test.counts.failed + test.counts.untested;
  return (
    <section className="app-test-card" aria-label="App test results">
      <h3>
        {test.status === "running"
          ? "Testing the app…"
          : test.status === "interrupted"
            ? "Test interrupted"
            : "Test results"}
      </h3>
      <div className="app-test-counts">
        <span className="app-test-passed">Passed {test.counts.passed}</span>
        <span className="app-test-failed">Failed {test.counts.failed}</span>
        <span className="app-test-untested">Untested {test.counts.untested}</span>
      </div>
      {total === 0 && test.status !== "running" && <p>No assertions were recorded.</p>}
      {test.assertions.length > 0 && (
        <ul className="app-test-assertions">
          {test.assertions.map((assertion) => (
            <li key={assertion.id} className="app-test-assertion">
              <span>{assertion.expectation}</span>
              <span
                className={`app-test-status app-test-${assertion.result === "passed" ? "passed" : assertion.result === "failed" ? "failed" : "untested"}`}
              >
                {assertion.result}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="app-test-actions">
        <button
          type="button"
          disabled={!playable}
          title={playable ? "Watch this app test" : "No recording is available."}
          onClick={() => watch?.(test.turnId)}
        >
          Watch recording
        </button>
        {test.counts.failed > 0 && (
          <button
            type="button"
            className="app-test-primary"
            disabled={running || !onFix || repair === undefined}
            onClick={() => {
              if (repair !== undefined) onFix?.(repair, test.turnId);
            }}
          >
            Fix it
          </button>
        )}
      </div>
    </section>
  );
}
