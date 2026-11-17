# ADR-0036 — A reviewer checks the claim, and only what it ran can block

**Status:** Accepted, 2026-11-17.

## Context

The Terminal-Bench baseline ([napbench-terminal-bench-baseline.md](../napbench-terminal-bench-baseline.md))
found that when Nap's agent said it was done, the hidden tests agreed 5 times in 13. In the product a
completed turn is arbitrated by the project's own checks (ADR-0006), but those only catch what a
project's `typecheck`, `lint`, `build` and `test` scripts catch. A change that compiles, passes an
unrelated test suite and does not do what was asked goes out as a verified commit, and for an
imported GitHub project, as a pull request.

A reviewer is a second model that did not do the work, asked whether the work does what was asked.
Two things make one dangerous. A model asked to find problems finds some, real or not, and a
reviewer that can send the agent back on an invented problem spends the person's money making the
work worse. And extra model calls are extra effort: a measured gain could come from the agent
getting more steps, not from the review.

## Decisions

### D1: One reviewer, called by the system after the agent claims done

`NapReviewer` (`packages/agent/src/reviewer.ts`) runs its own short model loop with a fresh
conversation: the request, the files the agent changed, and the project. It is called by the
composition after a turn completes, never by the agent, and the agent cannot start, skip or read it.

It is not a helper (ADR-0020 D7) though it borrows a helper's parts: `executeTool`, the tool
definitions and the command guard. A helper is a tool the agent chooses to call, inside the turn's
budget, and its tool calls are deliberately hidden from everything but its report. The reviewer is a
gate, so the agent must not be the one choosing; it runs after the turn has ended and its budget
with it; and it needs exactly what a helper hides, the record of its own commands and what they
printed, to confirm a finding (D3).

Both compositions use this class with the same prompt (`@nap/context/review-prompt`) and the same
rule for what blocks: the product's job and the Terminal-Bench turn (`runTaskTurn`). The benchmark
measures the reviewer users get.

### D2: It reads and runs; it never edits

It is offered `read_file`, `list_files`, `glob`, `search_files` and `run_command`, and nothing that
writes. `run_command` passes the same command guard as the agent's. A command can still write (a
test run leaves caches), so in the product, where the turn's work is already committed, the
workspace is reset to that commit after the review, and nothing the reviewer did reaches the next
turn or the pull request. A Terminal-Bench machine has no commit to reset to, so there the tool set
and the prompt are the only guard; that is a limitation of the benchmark composition.

### D3: Only a finding it confirmed by running something can block

The reviewer ends with a JSON report of `problems` and `notes`. A problem must name a command and
quote what it printed. A problem **blocks** only if that command is one the reviewer ran in this
review through `run_command`, and the quoted text appears in that command's output. This is checked
by code against the reviewer's own record, not taken from the model. Every other problem, every
note, and any report that cannot be parsed is non-blocking. A reviewer that fails (out of steps, a
model error) blocks nothing. Failing open is the point: the review can only add evidence, never
substitute its opinion for the checks.

### D4: Rounds are capped, inside the job's existing repair bound

A blocking review sends the agent back with the problems quoted, the way a failed check does. In
the product the review is recorded as a check named `review` in `verification.completed`, so a
blocked review becomes a repair through the existing machinery: it counts against the job's repair
attempts (`MAX_REPAIR_ATTEMPTS`), a restart continues it from the log like any failed check, and
nothing new joins the event contract. A job runs at most `MAX_REVIEW_ROUNDS` reviews; after that the
checks alone arbitrate.

### D5: Who pays, and what counts as more effort

The reviewer runs on the turn's model with the turn's credentials, so it is billed to whoever pays
for the turn, the person on their own key and the deployment otherwise. Its steps are capped per
review, and its usage is logged.

On the benchmark, the agent's steps stay capped at the baseline's 20 **across the whole task**: a fix
round gets only the steps the first turn left. The reviewer's own steps are separate, capped, and
reported beside the score, with its cost. So the agent never gets more steps than in the baseline,
and the only added effort is the review itself, which can read and run but cannot change the
answer. A task that ran out of steps never claimed done and is never reviewed.

### D6: Imported GitHub projects only, for now

The product runs the review only for an imported repository's job, after its checks pass and before
the job is published. A Nap starter project's turns are small edits to a template a person is
watching in the preview; a review there is cost without the pull request it protects.

## Deferred

- **Notes on the pull request.** Non-blocking findings are in the log, as the `review` check's
  output. Putting them in the pull request needs the publisher to read the log or the job row to
  carry them.
- **Checks derived from a repository's CI config, with a per-repository override.** The review does
  not depend on it, and it is the product path's own change.

## Consequences

- An imported project's job takes longer and costs more when its checks pass: one review of up to
  `REVIEW_MAX_STEPS` model calls, and up to two more repair turns if the review blocks.
- A `review` check can appear in a job's checks, failed or passed. A passed review's notes are its
  output.
- Whether this lowers false claims of done is measured on the locked Terminal-Bench test set,
  beside the baseline.
