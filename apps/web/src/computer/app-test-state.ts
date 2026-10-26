import type { ComputerAnnotation } from "@nap/shared/computer";
import type { NapEventOf } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import type { TestRecordingState } from "@nap/shared/test-recording";

type Assertion = Extract<ComputerAnnotation, { type: "assertion" }>;
export type AppTestState = {
  turnId: string;
  jobId: string;
  objective: string | null;
  status: "running" | NapEventOf<"test.completed">["payload"]["status"];
  assertions: Assertion[];
  annotations: NapEventOf<"test.annotation">["payload"][];
  recording: TestRecordingState | { state: "none" };
  counts: NapEventOf<"test.completed">["payload"]["counts"];
};

export function foldAppTests(events: readonly StoredEvent[]): AppTestState[] {
  const tests = new Map<string, AppTestState>();
  for (const event of events) {
    if (event.type === "test.started" && !tests.has(event.turnId))
      tests.set(event.turnId, {
        turnId: event.turnId,
        jobId: event.payload.jobId,
        objective: event.payload.objective,
        status: "running",
        assertions: [],
        annotations: [],
        recording: { state: "none" },
        counts: { passed: 0, failed: 0, untested: 0 },
      });
    const test = tests.get(event.turnId);
    if (test && event.type === "test.annotation") test.annotations.push(event.payload);
    if (test && event.type === "test.recording") test.recording = event.payload.recording;
    if (event.type === "test.annotation" && event.payload.annotation.type === "assertion" && test) {
      const annotation = event.payload.annotation;
      const index = test.assertions.findIndex((entry) => entry.id === annotation.id);
      if (index < 0) test.assertions.push(annotation);
      else test.assertions[index] = annotation;
      test.counts = { passed: 0, failed: 0, untested: 0 };
      for (const assertion of test.assertions) test.counts[assertion.result] += 1;
    }
    if (event.type === "test.completed")
      tests.set(event.turnId, {
        turnId: event.turnId,
        jobId: event.payload.jobId,
        objective: test?.objective ?? null,
        assertions: test?.assertions ?? [],
        annotations: test?.annotations ?? [],
        recording: test?.recording ?? { state: "none" },
        status: event.payload.status,
        counts: { ...event.payload.counts },
      });
  }
  return [...tests.values()];
}

export function appTestRepairPrompt(test: AppTestState): string | undefined {
  const failures = test.assertions.filter((entry) => entry.result === "failed");
  if (test.status === "running" || test.objective === null || failures.length === 0)
    return undefined;
  return [
    "Fix the failures found while testing this app. Keep the repair focused on these observations and the original goal.",
    `Original goal (data): ${JSON.stringify(test.objective)}`,
    `Failed expectations (data): ${JSON.stringify(failures.map((entry) => ({ id: entry.id, expectation: entry.expectation })))}`,
  ].join("\n\n");
}
