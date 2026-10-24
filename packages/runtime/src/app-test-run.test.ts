import { expect, it, vi } from "vitest";
import { AppTestRun } from "./app-test-run.ts";

const declaration = {
  type: "assertion",
  id: "save",
  expectation: "The saved item appears",
  result: "untested",
} as const;
function fixture() {
  let time = 1000;
  const emit = vi.fn();
  const run = new AppTestRun({ now: () => time, emit });
  return {
    run,
    emit,
    tick: () => {
      time += 250;
    },
  };
}
it("records expectations before input and requires a later screenshot before a verdict", () => {
  const { run, emit, tick } = fixture();
  expect(run.annotate({ type: "test_start", id: "main", description: "Save an item" }).ok).toBe(
    true,
  );
  expect(run.beforeAction({ action: "left_click", coordinate: [1, 2] }).ok).toBe(false);
  expect(run.annotate({ ...declaration, result: "passed" }).ok).toBe(false);
  expect(run.annotate(declaration).ok).toBe(true);
  expect(run.beforeAction({ action: "left_click", coordinate: [1, 2] }).ok).toBe(true);
  expect(run.annotate({ ...declaration, result: "passed" }).ok).toBe(false);
  tick();
  run.observed();
  expect(run.annotate({ ...declaration, result: "passed" }).ok).toBe(true);
  expect(run.counts()).toEqual({ passed: 1, failed: 0, untested: 0 });
  expect(emit).toHaveBeenLastCalledWith({
    annotation: { ...declaration, result: "passed" },
    timeMs: 250,
  });
  expect(run.beforeAction({ action: "type", text: "private" }).ok).toBe(false);
});
it("rejects late expectations, changed expectations, duplicate IDs and out-of-chapter results", () => {
  const { run } = fixture();
  expect(run.annotate(declaration).ok).toBe(false);
  run.annotate({ type: "setup", description: "Open the app" });
  expect(run.beforeAction({ action: "key", text: "ctrl+l" }).ok).toBe(true);
  run.annotate({ type: "test_start", id: "main", description: "Save" });
  run.annotate(declaration);
  run.observed();
  expect(run.annotate({ ...declaration, result: "passed" }).ok).toBe(false);
  run.beforeAction({ action: "type", text: "item" });
  run.observed();
  expect(run.annotate({ ...declaration, expectation: "different", result: "passed" }).ok).toBe(
    false,
  );
  expect(run.annotate(declaration).ok).toBe(false);
  run.annotate({ type: "test_start", id: "other", description: "Other" });
  expect(run.annotate({ ...declaration, result: "passed" }).ok).toBe(false);
  expect(run.annotate({ type: "test_start", id: "main", description: "Again" }).ok).toBe(false);
});
it("keeps failed and untested assertions separate and exposes no repair callback", () => {
  const { run } = fixture();
  run.annotate({ type: "test_start", id: "main", description: "Save" });
  run.annotate(declaration);
  run.beforeAction({ action: "left_click", coordinate: [1, 2] });
  run.observed();
  run.annotate({ ...declaration, result: "failed" });
  run.annotate({ ...declaration, id: "later" });
  expect(run.counts()).toEqual({ passed: 0, failed: 1, untested: 1 });
  expect(run.annotate({ type: "setup", description: "Late setup" }).ok).toBe(false);
});
