import { describe, expect, it } from "vitest";
import { BENCH_TASKS, BENCHMARK_SUITE, HARD_SUITE, resolveSelection, SUITES } from "./suite.ts";
import { parseBenchTask } from "./task.ts";

function resolved(selection: Parameters<typeof resolveSelection>[0]) {
  const result = resolveSelection(selection);
  if (!result.ok) throw new Error(`expected a resolution, got: ${result.error}`);
  return result.value;
}

function refused(selection: Parameters<typeof resolveSelection>[0]): string {
  const result = resolveSelection(selection);
  if (result.ok) throw new Error("expected the selection to be refused");
  return result.error;
}

describe("the registry", () => {
  it("holds every task the CLI can be asked for, under a unique id", () => {
    const ids = BENCH_TASKS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("holds only tasks that validate", () => {
    for (const task of BENCH_TASKS) expect(parseBenchTask(task).ok).toBe(true);
  });
});

describe("the suites", () => {
  it("names the four benchmark tasks as the suite a model is characterised by, and no others", () => {
    // **This suite is frozen.** Three funded runs are recorded against exactly these four
    // tasks, and a suite is a name for a fixed list precisely so that adding a task cannot
    // silently change what a past result meant. A harder task goes in `hard`; adding one here
    // is meant to fail this test and make somebody argue for it.
    expect(SUITES[BENCHMARK_SUITE]).toEqual([
      "landing-page",
      "todo-crud",
      "debug-broken",
      "responsive-layout",
    ]);
  });

  it("names the harder tasks separately, so the two can be funded apart", () => {
    expect(SUITES[HARD_SUITE]).toEqual(["expense-ledger"]);
  });

  it("keeps the hard tasks out of the frozen suite", () => {
    // Stated as its own assertion rather than left implicit in the list above: the mistake
    // this catches is adding a task to both, which quietly reprices `all`.
    for (const taskId of SUITES[HARD_SUITE]) {
      expect(SUITES[BENCHMARK_SUITE]).not.toContain(taskId);
    }
  });

  it("name only tasks that are in the registry", () => {
    // The failure this guards is a suite naming a task that was renamed out from under it,
    // which would otherwise surface as an error partway through a paid run.
    const ids = new Set(BENCH_TASKS.map((task) => task.id));
    for (const taskIds of Object.values(SUITES)) {
      for (const taskId of taskIds) expect(ids).toContain(taskId);
    }
  });
});

describe("resolveSelection", () => {
  it("resolves one task by id", () => {
    const selected = resolved({ kind: "task", taskId: "todo-crud" });

    expect(selected.name).toBe("todo-crud");
    expect(selected.tasks.map((task) => task.id)).toEqual(["todo-crud"]);
  });

  it("resolves a suite to its tasks, in the order the suite declares them", () => {
    const selected = resolved({ kind: "suite", suiteName: BENCHMARK_SUITE });

    expect(selected.name).toBe(BENCHMARK_SUITE);
    expect(selected.tasks.map((task) => task.id)).toEqual(SUITES[BENCHMARK_SUITE]);
  });

  it("refuses an unknown task, and says which ones exist", () => {
    const error = refused({ kind: "task", taskId: "todo-crudd" });

    expect(error).toMatch(/todo-crudd/);
    expect(error).toMatch(/todo-crud/);
  });

  it("refuses an unknown suite, and says which ones exist", () => {
    const error = refused({ kind: "suite", suiteName: "everything" });

    expect(error).toMatch(/everything/);
    expect(error).toMatch(new RegExp(BENCHMARK_SUITE));
  });
});
