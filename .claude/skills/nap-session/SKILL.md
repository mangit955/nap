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

Read the task's entry in `docs/PLAN.md` §4. Every task lists its **tests first** — write them, watch them fail *for the right reason*, then implement. Conventions are in `CLAUDE.md`; the constraints for the area you are touching are in `docs/GOTCHAS.md`.

---

## Mode: `finish`

This is the **Definition of done** gate from `CLAUDE.md`, made executable. **Create a todo per step below and work them in order** — the value is in walking it, not recalling it.

### 1. Gates pass

```bash
bun run test && bun run typecheck && bun run lint
```

Read the real output. Do not claim a task is done on the strength of having written the code.

### 2. Prove anything that guards actually guards

If the task produced a check, validator, test, or enforcement rule: **deliberately break what it protects, confirm it catches the breakage, then revert.**

A check that has never been observed failing is not known to work — it may be passing on everything. Examples from this repo: injecting a forbidden dependency into a `package.json` to prove `test/architecture.ts` fires; shortening a `Deps` cell to prove `test/docs.ts` fires.

### 3. Integration review — the step that gets skipped

Ask all four explicitly:

- **Is the new code inside *every* existing gate?** A new directory is not automatically typechecked or linted. Verify it, don't assume it. *(This is not hypothetical — `test/` shipped outside typecheck for two commits.)*
- Does it interact with the hooks in `.claude/settings.json`, lefthook, or CI?
- Does any existing test, script, config, or glob need to learn it exists?
- Do `CLAUDE.md`, `docs/GOTCHAS.md`, `docs/PLAN.md`, and `PROGRESS.md` still describe reality?

### 4. Satisfy the task's own "Done when"

Each `docs/PLAN.md` §4 entry ends with a **Done when** clause, frequently stricter than "tests pass" — M2-7 wants ordering tests green *10 runs in a row*; M1-3 wants a recorded cold-start time. Meet the literal criterion.

### 5. Record it

Mark the row `DONE` in `PROGRESS.md`, with a one-line note on anything surprising — a workaround, a deviation, a number the plan asked you to record. Future sessions read these notes and nothing else about how the task went.

### 6. Commit, and leave the tree clean

```bash
git commit -m "feat(<scope>): <task id> <summary>"
```

Tests in the same commit. Confirm `git status` is clean. Push and check CI when convenient — CI is not a blocker for marking `DONE`, but it is where a gap invisible locally would surface.

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
| Conventions, commands, gates | `CLAUDE.md` |
| Why the code is shaped this way | `docs/GOTCHAS.md`, by area |
| Task status and deps | `PROGRESS.md` |

Branch per milestone (`feat/m0-scaffold`, `feat/m1-execution-plane`, …), one commit per completed task.
