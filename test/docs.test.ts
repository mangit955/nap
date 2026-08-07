import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareTaskTables, parsePlanTasks, parseProgressTasks } from "./docs.ts";

const repoRoot = join(import.meta.dirname, "..");
const plan = readFileSync(join(repoRoot, "docs/PLAN.md"), "utf8");
const progress = readFileSync(join(repoRoot, "PROGRESS.md"), "utf8");

describe("PLAN.md §4 ↔ PROGRESS.md stay in sync", () => {
  // PROGRESS.md is what every cold session trusts to answer "what's next?".
  // If its task list or deps drift from the plan, a session picks up a task
  // whose real dependencies aren't met and only finds out much later.
  it("agree on the task set and every task's deps", () => {
    expect(compareTaskTables(parsePlanTasks(plan), parseProgressTasks(progress))).toEqual([]);
  });

  it("finds a non-trivial number of tasks in each (guards a silently-empty parse)", () => {
    // A regex that matches nothing would make the check above pass vacuously.
    expect(parsePlanTasks(plan).length).toBeGreaterThan(30);
    expect(parseProgressTasks(progress).length).toBe(parsePlanTasks(plan).length);
  });

  it("only uses known statuses", () => {
    const valid = ["TODO", "IN_PROGRESS", "DONE", "BLOCKED", "SKIPPED"];
    for (const task of parseProgressTasks(progress)) {
      expect(valid, `${task.id} has status "${task.status}"`).toContain(task.status);
    }
  });
});

describe("the comparison actually catches drift", () => {
  const planTasks = [
    { id: "M0-1", deps: [] },
    { id: "M0-2", deps: ["M0-1"] },
  ];

  it("reports a task present in the plan but missing from progress", () => {
    const issues = compareTaskTables(planTasks, [{ id: "M0-1", deps: [], status: "DONE" }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("M0-2");
    expect(issues[0]).toContain("missing from PROGRESS.md");
  });

  it("reports a task in progress that the plan doesn't define", () => {
    const issues = compareTaskTables(planTasks, [
      { id: "M0-1", deps: [], status: "DONE" },
      { id: "M0-2", deps: ["M0-1"], status: "DONE" },
      { id: "M9-9", deps: [], status: "TODO" },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("M9-9");
  });

  it("reports mismatched deps", () => {
    const issues = compareTaskTables(planTasks, [
      { id: "M0-1", deps: [], status: "DONE" },
      { id: "M0-2", deps: ["M0-1", "M0-5"], status: "TODO" },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("M0-2");
    expect(issues[0]).toContain("deps");
  });

  it("is order-insensitive on deps", () => {
    const issues = compareTaskTables(
      [{ id: "M2-8", deps: ["M2-7", "M2-3", "M1-5", "M0-5"] }],
      [{ id: "M2-8", deps: ["M0-5", "M1-5", "M2-3", "M2-7"], status: "TODO" }],
    );
    expect(issues).toEqual([]);
  });
});

describe("parsers", () => {
  it("reads deps from the plan, treating 'none' as empty", () => {
    const tasks = parsePlanTasks(plan);
    expect(tasks.find((t) => t.id === "M0-1")?.deps).toEqual([]);
    expect(tasks.find((t) => t.id === "M2-8")?.deps).toEqual(["M2-7", "M2-3", "M1-5", "M0-5"]);
  });

  it("ignores the tooling table, which is deliberately not a plan task", () => {
    // T-1..T-5 live in PROGRESS.md only; they must not be reported as drift.
    expect(parseProgressTasks(progress).some((t) => t.id.startsWith("T-"))).toBe(false);
  });
});
