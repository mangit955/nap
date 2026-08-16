# ADR-0007 — The check primitive moves below both the runtime and the benchmark

**Status:** Accepted — 2026-08-16

## Context

ADR-0006 gives the runtime a verifier: run a project's checks in the sandbox, structure the result,
decide whether the turn's claim holds. NapBench has had one since it was built. They are the same
machinery.

Two modules in `packages/bench` are, as they stand, almost exactly what the runtime needs.

`preview.ts` tells "the app never started" apart from "nobody could reach the app" by probing from
*inside* the sandbox, on the grounds that a dev server which is up answers on loopback whatever the
public proxy is doing. It treats curl's exit 7 — could not connect — as the only answer meaning the
application did not start, and every other non-zero exit as the probe failing rather than the port
being shut. That distinction was expensive to arrive at and is precisely the one a runtime verifier
must not get wrong, because getting it wrong means telling a user their working app is broken
during a proxy hiccup.

`command-output.ts` keeps what a failed command actually said, budgeting each stream separately and
keeping the tail rather than the head. It exists because a funded run once reported a lint check as
`exit 1` and nothing else, with the reason — twenty-three characters, on the quiet stream — thrown
away.

Neither module touches Playwright. Both are written against `@nap/shared/ports/sandbox-manager`.
Both are pure in the sense ADR-0001 meant.

But `packages/bench` sits *beside* `shared`, not above `runtime`, and `test/architecture.ts`
enumerates what every package may depend on. `runtime → bench` is a new edge, and it is the wrong
edge: it makes the deployed system depend on its own benchmark, so every future change to scoring
or task schemas becomes a production change, and anyone auditing the layering finds the system
under test importing the thing that grades it.

There is also a vocabulary problem. `CONTEXT.md` defines **Check** as a NapBench concept — "one
acceptance criterion, and the only thing a score is ever made of". The runtime's verifier produces
things that are checks in every sense except that nothing scores them. A second `Check` in
`packages/runtime` would put two of them in the same trajectory JSON, which is the collision the
glossary exists to prevent.

## Decision

**Extract `packages/verify` (`@nap/verify`), beside `shared`, and have both depend on it.**

`bench → verify → shared`; `runtime → verify`. `preview.ts`, `command-output.ts` and the structured
check-result type move down, with their tests. This is a move, not a rewrite: the reasoning encoded
in those two files travels with them, which was the point.

**The name collision resolves by unification rather than by rename.** `@nap/verify` owns **Check** —
one command, run in a sandbox, that passed, failed, or was absent. NapBench's Check becomes that
plus a weight, a category and a required flag, which is what it always was; the scoring metadata was
never part of the primitive. `CONTEXT.md`'s main glossary gains **Check**, and the NapBench entry is
rewritten to build on it rather than to define it independently.

Renaming NapBench's `Task` to make room for the runtime's new durable unit was rejected on the same
principle in reverse: those two genuinely are different concepts, so the runtime's is called **Job**
and both keep their own entry. A collision is resolved by unifying when the things are the same and
by naming when they are not; the mistake would be picking the cheaper edit either time.

## Consequences

**`packages/bench` changes, and it was frozen.** The suite in `docs/NAPBENCH.md` is frozen as a
measurement instrument, which constrains task definitions and scoring — not the module boundary
underneath them. The move is import-path churn plus an architecture-table edit, and the bench tests
travelling with the modules are what demonstrates the behaviour did not change.

**`absent` becomes a runtime concept.** The passed/failed/absent triple was NapBench's, where the
gap between the last two is load-bearing for gates. It is load-bearing for the runtime too: a
project with no `test` script has not failed its tests, and treating a missing script as a failure
would put every fresh project into a repair loop it cannot exit.

**A third consumer is now cheap.** Nothing needs one today, and no abstraction was added in
anticipation of one.

**The forbidden edge is checked in test files too.** `test/architecture.ts` otherwise exempts tests
from the layer table — ADR-0001 has sibling packages arriving as devDependencies for their fakes,
and a test-only edge is not the layering that table is about. `@nap/bench` is the one exception:
a test importing it still has to typecheck, so scoring would still be something a shipped package
builds against, which is the whole objection above.
