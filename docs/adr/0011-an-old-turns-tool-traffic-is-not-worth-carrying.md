# ADR-0011 — An old turn's tool traffic is not worth carrying, even when it fits

**Status:** Accepted — 2026-08-24

## Context

A funded audit run drove four turns on one project against real E2B and a real model. Three jobs
verified. The fourth — *add a dark-mode toggle* — died on `budget_exceeded` at **403,478 tokens
against a 400,000 limit**. Its whole event log is committed as
`apps/web/src/testing/audit-session.json`, so what happened is reproducible for nothing;
`packages/context/scripts/measure-audit-session.ts` is the replay.

The obvious reading is that a long conversation outgrew the context window and the truncation
ladder in `NapContextEngine` either ran in the wrong order or ran too late. The measurement says
neither. **The ladder never ran at all.**

| turn | assembled context | context budget | steps | input re-sent | real usage |
|---|---|---|---|---|---|
| 1 | 554 | 80,000 | 7 | 3,878 | 35,614 |
| 2 | 4,728 | 80,000 | 9 | 42,552 | 111,900 |
| 3 | 10,313 | 80,000 | 11 | 113,443 | 221,649 |
| 4 | 15,746 | 80,000 | 14 | 220,444 | 403,478 → abandoned |

Estimated columns are the local four-characters-per-token approximation and run about half of what
the provider counted; the ratio is stable across all four turns, so the shape is what to read.

Two ceilings exist and they are not the same ceiling. `NAP_CONTEXT_BUDGET_TOKENS` caps **one
request**. `TurnBudget`'s `DEFAULT_MAX_TOKENS` caps **the sum over a turn's round trips**. Every
round trip re-sends the whole transcript, so a turn's bill is roughly the assembled size *times*
its step count — and both factors grow with the session. Turn 4 assembled to 20% of its per-request
budget and still spent five times what turn 1 did, because it was 15,746 tokens re-sent fourteen
times. Of that, **84% was re-sending turns 1–3.**

What is in those re-sent turns is the second half of the finding. At turn 4 the history was
7,155 tokens of tool-call arguments and 7,706 of tool output — 98% tool traffic, 2% anything a
person said. The arguments are the bodies of `write_file` and `edit_file` calls: the file contents
as they were three commits ago. And ladder step 1 could not have reclaimed them even under
pressure, because it elides `tool_result` content and never touches a `tool_use` input.

Raising the ceiling was the option ruled out before the work started, and the measurement is why it
would have been wrong rather than merely expensive: the growth is superlinear in session length, so
400,000 → 800,000 buys one more turn for twice the money.

## Decision

**Tool traffic from any turn older than the most recent one is emptied unconditionally, before the
budget is consulted.** The call survives with its shape intact — which tool, against which path —
and every string argument over 32 tokens is replaced with a marker, as is everything the call
printed. Prose, on both sides, is never touched.

The ladder is unchanged and stays where it is. It answers a different question — *this does not
fit* — and it is still the only answer to that one.

The premise the ladder rested on is what changed: that context is worth keeping while it fits.
A per-request budget makes that true for a single request and false for a turn, because the
multiplier is invisible from inside the engine. Fitting is not the test; being worth ten to forty
copies is.

What an old turn is consulted for is what was asked and what the agent said back. The file it wrote
is on disk one `read_file` away, and the command it ran can be run again — both of them are also
*current*, where the carried copy is a snapshot the workspace has since moved past.

## Consequences

**Turn 4 of the audit session assembles to 6,872 estimated tokens instead of 15,746, and its
re-sent input falls from 220,444 to 96,208** — a 56% cut, on the same log, changing nothing about
the model or the ceiling. The more useful number is the one beside it: assembled context grew
6,508 → 6,872 between turns 3 and 4, against 10,313 → 15,746 before. **It no longer grows with
session length**, so what is left growing is the step count alone.

**The agent may ask for a file it already read.** That is the cost, it is a round trip, and it is
paid only when the old contents actually mattered. The marker says a gap is a gap, so the
alternative it replaces is not "the model remembers" but "the model is confidently working from a
version that has been committed over three times".

**The 400,000-token turn budget stays where it is,** and this ADR is the stated reason. It was
never demonstrated to be the wrong number — it was reached by a turn spending most of its
allowance on copies of itself. Whether it is right is now a question that can be asked against a
session whose context does not grow, which is the only condition under which the answer means
anything.

**`verbatimTurns` is an option, defaulting to one, and the tests that pin the ladder pass a large
value.** Without that they would assert on turns staleness had already emptied, and each step of
the order would be pinned on nothing — the failure mode where a test passes because it has stopped
testing.

**Prompt caching is not the escape hatch it looks like.** A re-sent prefix is around a tenth of the
money and all of the budget: `TokenUsage` carries `inputTokens` and `outputTokens` and no cached
breakdown, and `TurnBudget` sums them. Making the ceiling count cached reads at their real weight
is a defensible separate change — it needs a field on the port and the provider's usage block — but
it would raise the effective ceiling rather than reduce what fills it, which is the move this
decision exists to avoid making first.
