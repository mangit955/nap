---
name: nap-session
description: Use when starting work on the Nap repo, picking up the next task, or finishing a task — runs the session protocol from docs/PLAN.md §1. Invoke with "start" to claim the next eligible task, "finish" to close out the current one, or "wip" to stop mid-task. Triggers on "what's next", "next task", "start a session", "mark this done", "wrap up".
---

# Nap session protocol

Mechanises `docs/PLAN.md` §1. The plan is built over many sessions with no shared memory between them, so these steps are what carry context forward. §1's own warning: **a future session cannot recover context that exists only in a dirty working tree.**

Pick the mode from the argument: `start` (default), `finish`, or `wip`.

---

## Mode: `start`

Create a todo per step and work them in order.

### 1. Orient

```bash
git status && git log --oneline -10 && git branch --show-current
```

If the tree is dirty, resolve that before anything else — it means a previous session ended mid-task. Read `PROGRESS.md` for an `IN_PROGRESS` row with a "next step" note; that work is the session's task, not a new one.

### 2. Read state

Read `PROGRESS.md`. Task *definitions* are in `docs/PLAN.md` §4 under the matching ID — read the entry for whatever task you're about to pick up, since `PROGRESS.md` deliberately doesn't restate them.

### 3. Confirm green BEFORE new work

```bash
bun run test
```

**If this is red, fixing it is the session's first task.** Do not start anything else. A red suite means the previous session violated the protocol, and building on it compounds the problem.

> Never run bare `bun test` — it invokes Bun's built-in runner over our Vitest files and reports nonsense. Always `bun run test`.

### 4. Pick the next task

The next task is the first row whose status is `TODO` **and** whose `Deps` are all `DONE`:

```bash
awk -F'|' '/^\| M[0-9]-[0-9] \|/ {
  gsub(/ /,"",$2); gsub(/ /,"",$5); gsub(/^ +| +$/,"",$4);
  if($5=="TODO"){print $2"  (deps: "$4")"; exit}
}' PROGRESS.md
```

Verify by eye that each listed dep is actually `DONE` before proceeding — the awk finds the first `TODO`, it does not resolve the dependency graph. If the deps aren't met, move down the table.

### 5. Claim it

Set the row to `IN_PROGRESS` in `PROGRESS.md` and commit **that single-line change on its own**:

```bash
git commit -m "chore(progress): <task id> IN_PROGRESS"
```

This is what tells the next session that someone is mid-task rather than that the task was never started.

### 6. Then do the work

Read the task's entry in `docs/PLAN.md` §4. Every task lists its **tests first** — write them, watch them fail *for the right reason*, then implement. Conventions are in `CLAUDE.md`.

---

## Mode: `finish`

### 1. Both gates must pass

```bash
bun run test && bun run typecheck
```

Paste the real output. Do not claim a task is done on the strength of having written the code.

### 2. Check the task's own "Done when"

Each `docs/PLAN.md` §4 entry ends with a **Done when** clause, and it is frequently stricter than "tests pass" — e.g. M2-7 requires the event-ordering tests to pass *10 runs in a row*; M1-3 requires a recorded cold-start time. Satisfy the literal criterion.

### 3. Record it

Mark the row `DONE` in `PROGRESS.md`, with a one-line note on anything surprising — a workaround, a deviation from the plan, a number the plan asked you to record. Future sessions read these notes and nothing else about how the task went.

### 4. Commit

```bash
git commit -m "feat(<scope>): <task id> <summary>"
```

Tests included in the same commit. Confirm the tree is clean afterwards.

---

## Mode: `wip`

For stopping mid-task. Never leave uncommitted work.

1. Commit what exists: `wip(<scope>): <task id> — <what's left>`
2. Leave the row `IN_PROGRESS` in `PROGRESS.md` with a concrete **next step** note — specific enough to act on cold, e.g. `next: add exec() streaming signature`, not `next: continue`.

---

## Reference

| Thing | Where |
|---|---|
| Task specs, "Done when" clauses | `docs/PLAN.md` §4 |
| Conventions, commands, gotchas | `CLAUDE.md` |
| Task status and deps | `PROGRESS.md` |

Branch per milestone (`feat/m0-scaffold`, `feat/m1-execution-plane`, …), one commit per completed task.
