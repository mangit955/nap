/**
 * Which tasks exist, and which sets of them are worth running together.
 *
 * The registry is a hand-written list rather than a directory scan: a task that stops being
 * part of the benchmark should have to be *removed*, and a file appearing in the folder should
 * not silently change what a suite means. It is also what lets a mistyped id be refused before
 * a sandbox exists, which on a paid run is the difference between a sentence and a bill.
 *
 * A suite is a name for an ordered list of task ids — the level at which a model is
 * characterised rather than a single result observed, per `CONTEXT.md`. Suites run serially,
 * so the order here is the order they happen in.
 */

import type { Result } from "@nap/shared/result";
import type { BenchTask } from "./task.ts";
import { DEBUG_BROKEN_TASK } from "./tasks/debug-broken.ts";
import { LANDING_PAGE_TASK } from "./tasks/landing-page.ts";
import { RESPONSIVE_LAYOUT_TASK } from "./tasks/responsive-layout.ts";
import { TODO_CRUD_TASK } from "./tasks/todo-crud.ts";
import { TRACER_TASK } from "./tasks/tracer.ts";

/**
 * Every task the CLI can be asked for by name.
 *
 * The tracer is in here beside the four real ones on purpose: it is the cheapest thing to
 * point the whole composition at when what is being checked is the apparatus rather than a
 * model, and having to edit a file to run it would defeat that.
 */
export const BENCH_TASKS: readonly BenchTask[] = [
  LANDING_PAGE_TASK,
  TODO_CRUD_TASK,
  DEBUG_BROKEN_TASK,
  RESPONSIVE_LAYOUT_TASK,
  TRACER_TASK,
];

/** The suite that characterises a model: the four benchmark tasks, in specification order. */
export const BENCHMARK_SUITE = "all";

/**
 * `satisfies` rather than an annotation, so the literal names survive: widening this to
 * `Record<string, …>` would make `SUITES[BENCHMARK_SUITE]` possibly-undefined and buy nothing.
 */
export const SUITES = {
  [BENCHMARK_SUITE]: ["landing-page", "todo-crud", "debug-broken", "responsive-layout"],
  /**
   * One task that exercises every stage without asserting much about the application.
   *
   * Useful for the same reason the tracer task exists — proving the pipeline joins up — and
   * kept as a suite so that "check the machinery" is a name rather than a piece of folklore.
   */
  smoke: ["tracer"],
} satisfies Record<string, readonly string[]>;

export const SUITE_NAMES: readonly string[] = Object.keys(SUITES);

/** A suite name that is known to exist. */
export type SuiteName = keyof typeof SUITES;

/** What the CLI was asked to run, before it is known to exist. */
export type BenchSelection =
  | { kind: "task"; taskId: string }
  | { kind: "suite"; suiteName: string };

export type ResolvedSelection = {
  /** What to call this in the summary and in the results: a task id, or a suite name. */
  name: string;
  /** In the order they will run, which for a suite is the order the suite declares. */
  tasks: readonly BenchTask[];
};

/**
 * Turns what was asked for into the tasks to run, or explains why it cannot.
 *
 * A typed failure rather than a throw, because the caller is a CLI whose job is to print the
 * problem and the alternatives — a stack trace naming a `Map` lookup helps nobody find out
 * that they wrote `todo-crudd`.
 */
/** Reads the table with a name nobody has checked yet, which is every name off a command line. */
function suiteTasks(name: string): readonly string[] | undefined {
  return Object.hasOwn(SUITES, name) ? SUITES[name as SuiteName] : undefined;
}

export function resolveSelection(selection: BenchSelection): Result<ResolvedSelection, string> {
  if (selection.kind === "task") {
    const task = BENCH_TASKS.find((candidate) => candidate.id === selection.taskId);
    if (task === undefined) {
      const known = BENCH_TASKS.map((candidate) => candidate.id).join(", ");
      return { ok: false, error: `no such task "${selection.taskId}". Known tasks: ${known}` };
    }
    return { ok: true, value: { name: task.id, tasks: [task] } };
  }

  const taskIds: readonly string[] | undefined = suiteTasks(selection.suiteName);
  if (taskIds === undefined) {
    return {
      ok: false,
      error: `no such suite "${selection.suiteName}". Known suites: ${SUITE_NAMES.join(", ")}`,
    };
  }

  const tasks: BenchTask[] = [];
  for (const taskId of taskIds) {
    const task = BENCH_TASKS.find((candidate) => candidate.id === taskId);
    // A suite naming a task that no longer exists is a bug in this file rather than in the
    // command line, and it is refused here so that it surfaces before the first sandbox is
    // created instead of halfway through a run somebody is paying for.
    if (task === undefined) {
      return {
        ok: false,
        error: `suite "${selection.suiteName}" names task "${taskId}", which is not registered`,
      };
    }
    tasks.push(task);
  }

  return { ok: true, value: { name: selection.suiteName, tasks } };
}
