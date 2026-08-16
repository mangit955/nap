# ADR-0006 — A completed turn is a claim, not a fact

**Status:** Accepted — 2026-08-16

## Context

v1's turn lifecycle ends on the model's word. `turn.completed` is emitted when the agent's loop
stops calling tools, the workspace is committed, and the session is handed back to the user. The
runtime never asks whether the code the agent just wrote compiles, passes its tests, or serves.

That is the single largest reliability gap in the system, and it is not a gap in the model. A model
that writes a type error is not misbehaving; it is doing the thing every model does at some rate.
What makes the error expensive is that Nap files it as a success, commits it, shows a preview
pointed at a dev server that is now failing to build, and waits for a human to notice. The failure
mode is the harness believing the model.

Three properties of the existing design constrain what can be done about it.

**A failed turn commits nothing.** `single-agent-runtime.ts` documents this as structure rather than
a branch: committing happens inside the `finalize` hook and the agent calls that hook on exactly one
path. A refusal or a crash leaves a project someone can still open.

**Only six tools exist**, and every one proxies to `SandboxManager`. `docs/PLAN.md` §0 and
`CLAUDE.md` both state it. A seventh tool is not forbidden, but it is a documented invariant that
would need reversing, and any tool the model chooses to call is a tool the model can choose not to
call.

**Never assert on model prose.** The testing convention permits assertions on tool-call sequences,
event types and ordering, and filesystem effects. Anything whose correctness rests on what the model
said is untestable here by policy.

Together these rule out the obvious designs. A `mark_complete` tool would be a seventh tool whose
tests reduce to trusting the model. Parsing the terminal message for a claim of doneness asserts on
prose. And simply running checks and refusing to commit on failure collides with the first
property from the other side: the repair attempt needs the broken code present in order to fix it,
so the broken code must be committed.

## Decision

**`turn.completed` stops being a terminal fact about the work and becomes the model's claim about
it.** The runtime arbitrates the claim.

A turn that mutated the workspace is committed as before, and then verified: the checks discovered
from the project's `package.json`, run cheapest-first — typecheck, lint, build, test — followed by
preview reachability, short-circuiting into repair at the first failure. Passing emits
`job.checkpointed`. Failing synthesises the next turn.

Four consequences follow, and each is the reason a piece of this is shaped the way it is.

**A repair is a Turn.** `Turn` widens from "one exchange within a session: a user message, whatever
the agent does about it" to "…a prompt — from the user, or from failed verification". This is the
whole reason no new machinery is needed: budgets, cancellation, event ordering, the append-then-
publish invariant, streaming, the chat pane and commit-on-completion all apply to a repair turn
unchanged, because it is not a new kind of thing. The alternative — a sub-turn concept below `Turn`
— would have required a parallel copy of every one of those, built to avoid editing one sentence of
the glossary.

**Commit and checkpoint separate.** Every completed turn still commits; the v1 invariant survives
verbatim. A **checkpoint** is a *verified* commit, recorded by `job.checkpointed` with its sha.
"Last known-good" now means last checkpoint rather than last commit, so a failed verification
cannot corrupt it by construction rather than by care. It also makes "is this project currently in
a valid state" a fact — `HEAD == last checkpoint` — rather than a judgement somebody renders by
reading the chat.

**The loop is bounded by attempts, not by a token ledger.** Three repair attempts per job. A
cumulative cross-turn budget was considered and rejected: it is a second accounting system to build
and test, where a cap on attempts bounds the worst case at three extra turns, which is the property
actually wanted. Per-turn budgets and cancellation are untouched.

**Exhaustion does not revert.** A job that spends its attempts with checks still red leaves the code
committed, `HEAD` diverged from the last checkpoint, and says so. Reverting would throw away work a
user can frequently push over the line with one sentence, in exchange for a tidier invariant nobody
asked for.

The verifier runs sandbox commands and a preview probe, and nothing else. Browser and accessibility
checks stay NapBench's alone — ADR-0001 assigns the browser to `apps/napbench` and to nothing that
ships, and reversing that here would put Playwright in the deployed API image for a class of failure
the command checks already catch. It leaves the observer strictly more capable than the system it
observes, which is the right way round.

## Consequences

**What is measured changes, so what measured it must be recorded.** ADR-0004 fixed NapBench's frame
as *the model, with Nap held fixed*. This decision moves Nap. Every score in the archive was
produced by a harness that did not verify, and a report records the model and the ceilings but
nothing about which Nap produced it. Run configuration therefore grows a harness identity; without
it, comparing a pre- and post-verification run repeats one level up exactly the
configuration-versus-consumption collapse `CONTEXT.md` warns about.

That is also the opportunity. The frame inverts cleanly — hold the model fixed and move the harness
— and `compare` already reports what moved per check. The claim this ADR makes is therefore
measurable rather than asserted.

**Turns per job are no longer one.** Anything that assumed a user message begets exactly one turn —
in the UI, in metrics, in NapBench's trajectory derivation — now sees up to four. Trajectory route
metrics in particular will count repair turns' tool calls, which is correct but changes the numbers.

**Cost rises on failing turns and only on failing turns.** A turn that mutates nothing is not
verified at all, and a turn that passes first time pays for the checks but no extra model call.
