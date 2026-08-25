import { BENCH_TASKS } from "@nap/bench/suite";
import { describe, expect, it } from "vitest";
import {
  HARBOR_TEST_SCRIPT,
  HARBOR_VERIFIER_FILE,
  harborInstruction,
  harborTaskFiles,
  harborTaskToml,
  taskMarker,
} from "./harbor-task.ts";

const task = BENCH_TASKS[0] as (typeof BENCH_TASKS)[number];
const judged = BENCH_TASKS.find((candidate) => candidate.intent !== undefined);

describe("a generated task directory", () => {
  it("holds the four files the harness looks for", () => {
    expect(harborTaskFiles(task).map((file) => file.path)).toEqual([
      "task.toml",
      "instruction.md",
      "environment/Dockerfile",
      "tests/test.sh",
    ]);
  });

  it("marks the verifier script executable and nothing else", () => {
    const executable = harborTaskFiles(task)
      .filter((file) => file.executable)
      .map((file) => file.path);

    expect(executable).toEqual(["tests/test.sh"]);
  });

  /**
   * The line the whole map is about: what a run is worth is decided by `rewardFor`, in this
   * repository, and the harness only re-emits it. A verifier that computed anything would be
   * scoring logic living somewhere no gate here covers.
   */
  it("verifies by calling this repository's own entrypoint", () => {
    expect(HARBOR_TEST_SCRIPT).toContain(`bun /tests/${HARBOR_VERIFIER_FILE} verify`);
    expect(HARBOR_TEST_SCRIPT).toContain("--job-dir=/logs/agent");
    expect(HARBOR_TEST_SCRIPT).toContain("--reward-dir=/logs/verifier");
  });

  it("lets the verifier's exit code end the trial, so a refusal is not read as a zero", () => {
    expect(HARBOR_TEST_SCRIPT).toContain("set -e");
  });

  it("carries none of the task's checks into the generated tree", () => {
    const tree = harborTaskFiles(task)
      .map((file) => file.contents)
      .join("\n");

    for (const check of task.checks) {
      if (check.kind === "command") expect(tree).not.toContain(check.command);
    }
    // `build_timeout_sec` is the harness's own image build, which is why "build" is not on
    // this list: what must not appear is anything that decides what a run is worth.
    for (const forbidden of ["weight", "category", "score_cap", "required"]) {
      expect(tree.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe("what the harness is told about a task", () => {
  it("names the task under a namespace of ours", () => {
    expect(harborTaskToml(task)).toContain(`name = "nap/${task.id}"`);
  });

  /**
   * A generated directory no gate here covers is the last place a second statement of the
   * scoring model should live. The report says which arithmetic produced its number.
   */
  it("says nothing about how a task is scored, judged or not", () => {
    for (const candidate of judged === undefined ? [task] : [task, judged]) {
      const toml = harborTaskToml(candidate).toLowerCase();
      for (const forbidden of ["half", "judge", "score", "intent"]) {
        expect(toml).not.toContain(forbidden);
      }
    }
  });

  it("escapes a task name rather than emitting broken TOML", () => {
    expect(harborTaskToml({ ...task, name: 'The "good" one' })).toContain(
      'description = "The \\"good\\" one"',
    );
  });

  it("gives a trial an hour, because a real one builds an application", () => {
    expect(harborTaskToml(task)).toContain("[agent]\ntimeout_sec = 3600.0");
  });
});

describe("the instruction a trial is started with", () => {
  it("carries the task id in a form the agent can read", () => {
    expect(harborInstruction(task)).toContain(taskMarker(task.id));
  });

  it("reproduces the prompts for a person reading the registry", () => {
    for (const prompt of task.prompts) expect(harborInstruction(task)).toContain(prompt);
  });

  it("generates a distinct instruction for every task in the suite", () => {
    const markers = new Set(BENCH_TASKS.map((each) => taskMarker(each.id)));

    expect(markers.size).toBe(BENCH_TASKS.length);
  });
});
