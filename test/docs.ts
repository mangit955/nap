/**
 * Keeps docs/PLAN.md §4 and PROGRESS.md from drifting apart.
 *
 * PROGRESS.md is what a cold session reads to answer "which task is next, and
 * are its dependencies met?" — see docs/PLAN.md §1. Its Deps column is a hand
 * transcription of the plan's `· deps:` lines, so without a check the two can
 * silently disagree and a session picks up a task whose real dependencies
 * aren't met.
 */

export type PlanTask = {
  id: string;
  deps: string[];
};

export type ProgressTask = PlanTask & {
  status: string;
};

/** Matches `**M2-8 — Runtime** · deps: M2-7, M2-3, M1-5, M0-5` */
const PLAN_TASK = /^\*\*(M\d-\d) — .*?· deps: ([^\n*]*)/gm;

/** Matches a milestone table row: `| M0-1 | Workspace scaffold | — | DONE | … |` */
const PROGRESS_ROW = /^\| (M\d-\d) \|([^|]*)\|([^|]*)\|([^|]*)\|/gm;

function splitDeps(raw: string): string[] {
  const trimmed = raw.trim();
  // The plan writes "none"; the table writes an em dash.
  if (trimmed === "" || trimmed === "none" || trimmed === "—" || trimmed === "all") return [];
  return trimmed
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d !== "");
}

export function parsePlanTasks(planMarkdown: string): PlanTask[] {
  return [...planMarkdown.matchAll(PLAN_TASK)].map((m) => ({
    id: m[1] ?? "",
    deps: splitDeps(m[2] ?? ""),
  }));
}

export function parseProgressTasks(progressMarkdown: string): ProgressTask[] {
  return [...progressMarkdown.matchAll(PROGRESS_ROW)].map((m) => ({
    id: m[1] ?? "",
    deps: splitDeps(m[3] ?? ""),
    status: (m[4] ?? "").trim(),
  }));
}

/** Returns a human-readable issue per disagreement; empty means in sync. */
export function compareTaskTables(plan: PlanTask[], progress: ProgressTask[]): string[] {
  const issues: string[] = [];
  const byId = new Map(progress.map((t) => [t.id, t]));

  for (const planTask of plan) {
    const row = byId.get(planTask.id);
    if (row === undefined) {
      issues.push(`${planTask.id} is defined in PLAN.md §4 but missing from PROGRESS.md`);
      continue;
    }
    const a = [...planTask.deps].sort();
    const b = [...row.deps].sort();
    if (a.join(",") !== b.join(",")) {
      issues.push(
        `${planTask.id} deps disagree — PLAN.md says [${planTask.deps.join(", ")}], PROGRESS.md says [${row.deps.join(", ")}]`,
      );
    }
  }

  const planIds = new Set(plan.map((t) => t.id));
  for (const row of progress) {
    if (!planIds.has(row.id)) {
      issues.push(`${row.id} appears in PROGRESS.md but is not defined in PLAN.md §4`);
    }
  }

  return issues;
}
