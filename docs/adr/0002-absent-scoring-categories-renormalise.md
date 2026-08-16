# ADR-0002 — Absent scoring categories renormalise rather than score zero

**Status:** Accepted — 2026-08-14

## Context

A NapBench run scores four categories — functional, browser, visual and code — weighted 50 / 25 /
15 / 10 into one overall figure.

Visual quality has no evaluator. Judging it automatically needs a vision model or a reference-image
strategy, and neither is being built now; the visual evaluator returns `not_run` until somebody
plugs one in. So 15% of the weight has nothing behind it on every run, for the foreseeable future.

The same hole appears for ordinary reasons too. A task may declare no code-quality checks. A landing
page task may reasonably have no command checks at all. Any scheme has to answer what happens to a
category's weight when that category has nothing to score.

## Decision

Categories with no checks that produced a result are **dropped from the weighting**, and the
remaining weights are rescaled to sum to 1. With visual absent, 50 / 25 / 10 becomes 58.8 / 29.4 /
11.8, and the overall score stays a meaningful figure on the same 0–100 scale as every other run.

Two things make that safe rather than convenient.

**The report records the effective weight vector actually used**, not just the configured one. A
score is not interpretable without knowing what it was a weighted mean of.

**`compare` refuses two runs whose effective weight vectors differ.** A run scored without visual
and a run scored with it are not on the same scale, and the comparison must say so rather than
subtract one number from the other. This is the part that makes renormalisation honest; without it,
the day the visual evaluator lands would silently reprice every historical result.

### The interaction with the gate ladder, which is the sharp edge

Renormalisation must never be reachable by *failing*. If a generated app never starts, its browser
checks cannot run — and if "cannot run" meant "absent", the browser category would be dropped and
its 25% redistributed to categories that did run. Failing to start would then *raise* the score.

So the gate ladder records browser checks as **failed**, not skipped, when the preview never serves.
"Absent" means the task never asked for this, which is a property of the task. "Failed" means the
task asked and did not get it, which is a property of the agent. Only the first renormalises. Every
gate has to be read with that distinction in mind, and the tests for it exist to pin exactly this
case.

A run whose turn failed outright scores `null` overall rather than 0, since no checks ran at all.
Suite-level reporting therefore carries an explicit `errorRate` beside the mean, and the mean is
labelled as being over completed runs — otherwise a model that crashes half its runs would look
better than one that finishes badly.

### A run without a score must say whose fault it was

`null` is only honest if the report also says *why* there is no score, because the reasons divide
into two kinds that must never be averaged together. An agent that refused the task and an E2B
provisioning outage both produce no score, and treating them alike would let a benchmark report
"model B scored 61" when model B's runs happened to land during a network problem. That is not a
weak result; it is not data at all.

So an errored run carries a typed `kind` alongside its message:

- **agent** — the agent genuinely failed at the work: a refusal, or an exhausted budget. Counts
  against the model.
- **model** — the provider was unreachable, throttled or briefly down. Does *not* count against the
  model's quality. Split out because `TurnFailureReason` already distinguishes `model_unavailable`
  from `internal`, on the explicit grounds that nothing is broken and the answer is to try again;
  collapsing that back into "agent error" would discard a distinction the event contract went to
  the trouble of making.
- **sandbox** — the execution plane: no sandbox could be provisioned, exec failed, the preview
  proxy was unreachable. Note `sandbox_unavailable` is a `TurnFailureReason`, so a turn failure is
  *not* automatically an agent error and must be mapped by reason rather than by outcome.
- **browser** — the host could not drive a browser at all: no binary, a connection that never
  established, a crash mid-session.
- **evaluator** — NapBench's own bug.
- **configuration** — a missing credential, a malformed task, bad arguments. Wrong before anything
  ran.

> **Superseded in part by ADR-0004.** The list above was the six kinds at the time. A seventh,
> `runtime`, was later added for Nap's own machinery breaking — which this ADR's list left folded
> into `agent`. It is infrastructure. Nothing else here changes.

Cancellation is not an error kind. A run an operator stopped is an incomplete observation rather
than a result, so it gets its own status and is excluded from the mean *and* from the error rate.

Suite reporting separates the agent-attributable error rate from the infrastructure-attributable
one, and the summary says so loudly when the latter is non-zero. A suite with infrastructure noise
in it is not comparable data, and the tool should be the thing that points that out rather than the
person reading it a week later.

### "The preview never served" is not automatically the agent's fault

The gate above fails a run whose preview never serves, on the reading that the agent produced an
application that does not start. That reading is sometimes wrong: the same symptom is produced by
E2B's public proxy failing while the dev server is running perfectly well inside the sandbox.

The two are cheaply separable, and NapBench separates them before deciding. If the port is not
listening inside the sandbox, the application did not start and the run *fails* — the agent's
result. If it is listening but unreachable from the host, the run *errors* with kind `sandbox` — an
infrastructure problem, scored `null` and kept out of the mean.

Without that one check, the most likely infrastructure failure in the whole system would be
recorded as the agent's worst possible outcome.

## Consequences

Every number NapBench reports today is on a scale that will change when the visual evaluator
arrives. That is acceptable because it is recorded and enforced, rather than discovered later.

Overall scores are comparable within a weight vector and refused across vectors. Cross-vector
comparison, if it is ever wanted, has to be asked for deliberately — it is not something a caller
can do by accident.

Scoring cannot be written as a fixed four-term expression. It is a fold over the categories that
produced results, which is slightly more code and considerably more testable: the renormalisation,
the absent-versus-failed distinction and each gate are separate pure functions with their own tests.

## Two refinements, from building the comparison

**The refusal is on the effective vector alone, not the configured one.** They answer different
questions, and only the effective vector is about whether two numbers are on one scale. Reweighting
a category that neither run scored changes the configuration and renormalises to exactly the same
effective vector — those two runs are comparable, and refusing them would be strictness bought with
a false reason. A configured change that genuinely moved the scale is caught anyway, because it
moved the effective vector.

**The refusal does not apply when either run has no score.** There is nothing to reprice on a run
that produced no number, and an unscored run has no categories at all — so refusing on a vector
mismatch would make an errored run incomparable with everything, which is exactly when its
counterpart is most worth reading.

## Alternatives considered

**Treat absent as zero.** Visual not run means visual scores 0, so nothing can exceed 85 overall
today. Trivially comparable across all time and impossible to game. Rejected because every figure
NapBench produced for the next several months would be depressed by a component deliberately not
built, which reads to any observer as the agent being worse than it is — and the headline number is
the thing people look at.

**Report per-category only, with no overall.** The most rigorous option: refuse to collapse to one
number while a quarter of the weighting is theoretical. Rejected because the CLI summary and
`compare` both need a single figure to rank by, and a benchmark nobody can quote a number from is a
benchmark nobody uses.
