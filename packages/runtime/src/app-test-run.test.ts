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
it("records expectations before input and requires a later screenshot before a verdict", async () => {
  const { run, emit, tick } = fixture();
  expect(
    (await run.annotate({ type: "test_start", id: "main", description: "Save an item" })).ok,
  ).toBe(true);
  expect(run.beforeAction({ action: "left_click", coordinate: [1, 2] }).ok).toBe(false);
  expect((await run.annotate({ ...declaration, result: "passed" })).ok).toBe(false);
  expect((await run.annotate(declaration)).ok).toBe(true);
  expect(run.beforeAction({ action: "left_click", coordinate: [1, 2] }).ok).toBe(true);
  expect((await run.annotate({ ...declaration, result: "passed" })).ok).toBe(false);
  tick();
  run.observed();
  expect((await run.annotate({ ...declaration, result: "passed" })).ok).toBe(true);
  expect(run.counts()).toEqual({ passed: 1, failed: 0, untested: 0 });
  expect(emit).toHaveBeenLastCalledWith({
    annotation: { ...declaration, result: "passed" },
    timeMs: 250,
  });
  expect(run.beforeAction({ action: "type", text: "private" }).ok).toBe(false);
});
it("rejects late expectations, changed expectations, duplicate IDs and out-of-chapter results", async () => {
  const { run } = fixture();
  expect((await run.annotate(declaration)).ok).toBe(false);
  await run.annotate({ type: "setup", description: "Open the app" });
  expect(run.beforeAction({ action: "key", text: "ctrl+l" }).ok).toBe(true);
  await run.annotate({ type: "test_start", id: "main", description: "Save" });
  await run.annotate(declaration);
  run.observed();
  expect((await run.annotate({ ...declaration, result: "passed" })).ok).toBe(false);
  run.beforeAction({ action: "type", text: "item" });
  run.observed();
  expect(
    (await run.annotate({ ...declaration, expectation: "different", result: "passed" })).ok,
  ).toBe(false);
  expect((await run.annotate(declaration)).ok).toBe(false);
  await run.annotate({ type: "test_start", id: "other", description: "Other" });
  expect((await run.annotate({ ...declaration, result: "passed" })).ok).toBe(false);
  expect((await run.annotate({ type: "test_start", id: "main", description: "Again" })).ok).toBe(
    false,
  );
});
it("keeps failed and untested assertions separate and exposes no repair callback", async () => {
  const { run } = fixture();
  await run.annotate({ type: "test_start", id: "main", description: "Save" });
  await run.annotate(declaration);
  run.beforeAction({ action: "left_click", coordinate: [1, 2] });
  run.observed();
  await run.annotate({ ...declaration, result: "failed" });
  await run.annotate({ ...declaration, id: "later" });
  expect(run.counts()).toEqual({ passed: 0, failed: 1, untested: 1 });
  expect((await run.annotate({ type: "setup", description: "Late setup" })).ok).toBe(false);
});

it("timestamps annotations with encoder time and awaits it before emission", async () => {
  const { run, emit } = fixture();
  let ready: ((time: number | null) => void) | undefined;
  const pending = run.annotate(
    { type: "setup", description: "Open the app" },
    () =>
      new Promise<number | null>((resolve) => {
        ready = resolve;
      }),
  );
  expect(emit).not.toHaveBeenCalled();
  if (!ready) throw new Error("Encoder clock was not requested.");
  ready(375);
  expect((await pending).ok).toBe(true);
  expect(emit).toHaveBeenLastCalledWith({
    annotation: { type: "setup", description: "Open the app" },
    timeMs: 375,
  });
});
