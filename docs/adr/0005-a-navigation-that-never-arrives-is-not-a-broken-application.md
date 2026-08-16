# ADR-0005 — A navigation that never arrives is not a broken application

**Status:** Accepted — 2026-08-16

## Context

The browser executor treated exactly one error code as the evaluator's own: `unavailable`, meaning
there is no browser to ask with. Everything else became a failed check — including
`navigation_failed`, which the port defines as "the page would not load: no response, a network
error, a navigation that never settled".

That covers several situations with nothing in common:

- a transient network failure
- the E2B preview proxy having a moment
- Chrome misbehaving
- a module graph slow enough to outlast the deadline
- an application that genuinely does not serve

Only the last is evidence about the agent, and all five were recorded identically — as the
application failing to load, docking the model's score. The failure is silent and one-directional:
it always makes the model look worse, never better.

The same problem was already solved one layer down, and solved well. A preview that never serves is
diagnosed by a probe that distinguishes "the port is not listening inside the sandbox" (the agent's
application did not start — a *failed* run with a score) from "the port is listening but the preview
URL is unreachable" (the execution plane — an *errored* run with none). The reasoning simply had not
been carried one step further, into the browser that navigates to the URL the probe just proved.

No real run has hit this: the three funded runs recorded zero infrastructure errors. It is a
vulnerability in the methodology rather than an observed defect.

## Decision

**A first arrival is retried, and a persistent failure is the evaluator's.**

The executor tries the opening navigation of a check up to three times. If it still fails, the check
is not recorded at all: the error is handed back for the gate ladder to attribute, exactly as a
missing browser is, and the run errors as `browser` with no score.

The justification is specific rather than general: **the preview gate has already proven that URL
serves** before any browser check is started. A navigation failing after that is a claim that
something changed between the probe and the check, which is a statement about the road rather than
the destination.

Three attempts because one transient failure is common and three in a row is not; three rather than
ten because each costs the navigation deadline, and a suite spending a minute per unreachable check
to reach the same conclusion is one nobody runs.

**Retries carry no backoff.** Navigation already has its own deadline, so a failure has waited out
whatever it was given; sleeping again adds delay to delay, and would mean injecting a clock into a
module that is otherwise pure and instant to test.

**Only `navigation_failed` is retried.** `unavailable` means there is no browser to try with, and
asking a browser that is not there twice more spends two more timeouts on a known answer.

**Nothing else changes.** A mid-check `navigate` or `reload` that fails is still a failed check, and
so are `not_found` and `action_failed`.

## Why the judgement lives in the executor, not the adapter

The obvious alternative is to split the port's `navigation_failed` into an application code and a
transport code, and let the Playwright adapter decide which it saw.

That is refused, and the reason is a rule the port already states: its methods act or they report a
measurement, and **none of them decides whether anything is correct**. Horizontal overflow is the
worked example — the port hands back two numbers and the executor compares them, because a
comparison living inside the adapter is a comparison the fake would have to reimplement, and two
implementations of one judgement are two chances to disagree about what a benchmark measured.

Classifying a navigation failure by cause is exactly such a judgement. It would also be built on
Playwright's own error strings, making them load-bearing across the seam, and would ask
`ScriptedBrowserSession` to model a distinction it has no basis for inventing.

Keeping it in the executor means the entire policy — the retries, the attribution, the line between
first arrival and later navigation — is a pure function exercised against the fake, with no Chrome
anywhere. The fake needed no change at all to test it: its failure hook takes a closure, so "fail
twice, then succeed" is a counter in the test.

## Why a later navigation is treated differently

A `reload` or a `navigate` step runs after the application has been successfully reached and driven.
The evidence there points the other way: the road was demonstrably fine moments ago, so a route that
will not load now is a fact about what the agent built.

Retrying those would launder the defects the benchmark exists to find — an application that breaks
after interaction, or a route that only works before a reload. A reload in particular is the step
that asks whether the work survived, and an application that cannot come back is the answer being
no.

## Consequences

A check can no longer report "the application failed to load" as an agent failure at its first
arrival. That is the point, but it does mean a genuinely dead application produces an *errored* run
rather than a failed one — no score, rather than a low score. This is the correct trade under
ADR-0002's reasoning: an unscored run is honest about having observed nothing, and the preview gate
already fails the run *with* a score in the case that actually indicates a broken application,
namely a port that never started listening.

A failing suite now costs up to three navigation deadlines per unreachable check instead of one.
Bounded, and only on the path that was already going to fail.

## Alternatives considered

**Attribute a persistent arrival failure to `sandbox` rather than `browser`.** Arguably more
accurate: the preview probe succeeded, so the most likely culprit is the proxy or the execution
plane rather than the browser driver. Rejected on the grounds that `browser` reports what was
actually *observed* — the browser half of the evaluator could not get there — while `sandbox` would
report an inference about why. Both are infrastructure, so the two-column ledger that decides
whether a suite is comparable data is identical either way, which is what makes this a naming
question rather than a correctness one. Worth revisiting if a real run ever produces one.

**Retry everything, including `not_found` and `action_failed`.** Rejected: those are what the
benchmark exists to find. The port already waits with a timeout, so a transient render is handled;
retrying beyond that masks real defects and slows every genuinely failing check by the whole retry
budget, on a suite whose difficulty is already in question.

**A diagnostic policy instead of retries** — on failure, read `diagnostics()` and decide from what
the page complained about. Rejected for this cut: diagnostics on a page that never loaded are thin,
and it adds a second decision path to test for a case no real run has yet produced.
