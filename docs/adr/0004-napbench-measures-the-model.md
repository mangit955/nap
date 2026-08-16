# ADR-0004 — NapBench measures the model, and Nap's own faults are infrastructure

**Status:** Accepted — 2026-08-16

## Context

NapBench's error kinds exist to keep an unscored run honest. A run that produced no score can still
contribute an *attribution*, and the suite summary reports agent-attributable and
infrastructure-attributable error rates in separate columns for that reason. The glossary states the
rule plainly: only `agent` counts against the model, and everything else is infrastructure.

The code contradicted it. `internal` — the turn failure reason Nap raises when its own machinery
breaks, a store that could not be read or a bug in the runtime — was mapped to the `agent` kind. So:

```
agent writes perfectly good code
        ↓
Nap's runtime falls over
        ↓
errorKind = agent
        ↓
the model's error rate goes up
```

The module's own comment acknowledged the tension and argued that "Nap's runtime is part of what is
being measured, so its failures belong on that side of the ledger". That is a coherent position, but
it is not the position the rest of the benchmark takes, and holding both at once meant the agent
error rate did not mean one thing.

The unstated question underneath was: **what is NapBench for?** Comparing models under one fixed
deployment, or measuring whether the whole Nap product can build an application? The two answers
attribute a runtime crash differently, and nothing had ever decided between them.

## Decision

**NapBench measures the model, with Nap held fixed.** Nap's runtime, the sandbox provider, the
browser driver and NapBench itself are all apparatus. The agent/infrastructure split does not ask
"was this our fault"; it asks "is this evidence about the model".

A seventh error kind, `runtime`, is added: the system under test's own plumbing broke. `internal`
maps to it. It attributes to **infrastructure**.

`evaluator` narrows back to its documented meaning — NapBench crashing on itself. `runtime` and
`evaluator` are both infrastructure and differ in which source tree a reader should open: a suite
full of `runtime` is a deployment to fix, one full of `evaluator` is a benchmark to fix.

`refusal` and `budget_exceeded` remain attributed to `agent`. A budget is fixed configuration in
the same way the prompt and the context engine are, and a model that never converges within one is
exhibiting a real behaviour worth counting. The honesty requirement that follows — that two runs
held at different budgets must not be compared — is handled by a guard in the comparison, and is
recorded in the amendment below.

## Why not fold it into `evaluator`

`evaluator` would have got the attribution right today at the cost of the word meaning two things.
It is currently precise — the instrument crashed — and widening it to "the instrument, plus
everything under test that is not the model" is the same confusion the old `agent` mapping had,
pointing the other way: it files a bug in the system under test as a bug in the instrument.

The concrete loss is diagnostic. An errored run's kind is the only thing it contributes, and a
reader looking at a run of `evaluator` errors could no longer tell whether to open NapBench's source
or Nap's. That distinction is most valuable exactly when there are a lot of them.

## Why not leave it on `agent`

Because the failure mode is silent and one-directional. A misattributed runtime crash always makes
the model look worse and never better, so a deployment having a bad week is indistinguishable from a
model that refuses a lot — and the number that is supposed to detect an untrustworthy suite is the
number being corrupted. Every other kind in the taxonomy exists to prevent precisely this, which is
what made the exception hard to defend once it was written down.

## Consequences

The enum was **widened**, not renamed, so every report already on disk still parses and the three
funded runs remain readable and comparable. Reports written before this change that recorded `agent`
for what would now be `runtime` are not rewritten — there were none, since nothing had raised
`internal`, but the general rule is that archived reports are historical records rather than data to
migrate.

The attribution table stays a total record over the kind union, so an eighth kind fails typecheck
until somebody classifies it deliberately. This is the mechanism by which `runtime` was added: the
entry went into the enum, the compiler named the record that had to change. The guard was
deliberately broken and observed failing (`TS2741`) before this was accepted.

`agent` is now a narrow kind — two failure reasons, both of them decisions the agent made. That is
the point, and it means the agent error rate will usually be zero. A non-zero one is now a genuine
finding rather than a mixture of findings and weather.

## Alternatives considered

**Collapse `sandbox` into `runtime`.** Both are, loosely, the execution plane. Rejected and
deliberately deferred: `sandbox` means the provider had a bad afternoon and `runtime` means we have
a bug, and those route to different people. The distinction is currently earning its keep.

**Make attribution a function of the question being asked** — a model-comparison view where
`runtime` is infrastructure, and a deployment-health view where it is a Nap defect. Rejected as
premature. It is a reporting concern rather than a taxonomy one, and it stays available: the kinds
are recorded per run, so any grouping can be applied later without the stored data changing.

## Known gap — the budget guard does not exist yet

Keeping `budget_exceeded` on `agent` is only honest while the budget is genuinely held fixed. Two
runs at different budgets are not comparable on that axis: "this model ran out" would be a property
of a setting presented as a property of a model.

Nothing enforces that today. The turn budget is constructed in the benchmark application and never
reaches the report, so a comparison cannot see it and does not refuse. **The attribution decided
above is therefore sound in principle and unguarded in practice**, and anyone comparing two runs
must currently check by hand that both were held at the same budget.

Closing it means recording the run's configuration on the report and refusing a comparison across
budgets — deliberately *not* across models, since comparing models is what the comparison is for.
This ADR will be amended when that lands, and until then the gap is stated here rather than left
for a reader to discover.
