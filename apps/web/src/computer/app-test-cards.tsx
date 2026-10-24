"use client";

import { appTestTarget } from "@nap/shared/app-testing";
import { modelSupportsImages } from "@nap/shared/model-capabilities";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { use } from "react";
import type { TurnSubmission } from "../chat/use-turn-submission.ts";
import { type AppTestState, appTestRepairPrompt } from "./app-test-state.ts";
import { ComputerNavigation } from "./navigation.tsx";
import { RecordingNavigation } from "./recording-navigation.tsx";

export function AppTestCards({
  events,
  running,
  testPhase = "idle",
  model,
  onTest,
}: {
  events: readonly StoredEvent[];
  running: boolean;
  testPhase?: TurnSubmission["testPhase"];
  model: string | undefined;
  onTest?: ((jobId: string) => void) | undefined;
}) {
  const openComputer = use(ComputerNavigation);
  const target = appTestTarget(events);
  const reason = running
    ? "Wait for the current turn to finish."
    : !modelSupportsImages(model)
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
    <div className="app-test-cards">
      <section className="app-test-card" aria-label="Test the app">
        <h3>Test the app</h3>
        <p>Let Nap try the most important flow in its computer.</p>
        <button
          type="button"
          className="app-test-primary"
          disabled={reason !== null}
          onClick={() => {
            openComputer?.(null);
            onTest?.(target.jobId);
          }}
        >
          {progress ?? "Test the app"}
        </button>
        {progress ? (
          <p className="app-test-reason" role="status" aria-label="App test progress">
            {progress} The plan, computer actions and results will appear in this conversation.
          </p>
        ) : (
          reason && <p className="app-test-reason">{reason}</p>
        )}
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
  onFix?: ((message: string) => void) | undefined;
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
              if (repair !== undefined) onFix?.(repair);
            }}
          >
            Fix it
          </button>
        )}
      </div>
    </section>
  );
}
