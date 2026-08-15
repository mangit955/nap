import { describe, expect, it } from "vitest";
import { BENCH_TASKS, BENCHMARK_SUITE, resolveSelection, SUITE_NAMES, SUITES } from "./suite.ts";
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
  it("names the four benchmark tasks as the suite a model is characterised by", () => {
    expect(SUITES[BENCHMARK_SUITE]).toEqual([
      "landing-page",
      "todo-crud",
      "debug-broken",
      "responsive-layout",
    ]);
  });

  it("name only tasks that are in the registry", () => {
    // The failure this guards is a suite naming a task that was renamed out from under it,
    // which would otherwise surface as an error partway through a paid run.
    const ids = new Set(BENCH_TASKS.map((task) => task.id));
    for (const name of SUITE_NAMES) {
      for (const taskId of SUITES[name] ?? []) expect(ids).toContain(taskId);
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
