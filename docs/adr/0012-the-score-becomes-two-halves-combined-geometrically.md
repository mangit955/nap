# ADR-0012 — The score becomes two halves, combined geometrically

**Status:** Accepted — 2026-08-25
**Supersedes in part:** [ADR-0002](0002-absent-scoring-categories-renormalise.md) — its four-category
weighted mean is now one *half* of a score rather than the whole of one, and its `visual` category
is retired in favour of the product half. Everything ADR-0002 says about renormalisation, about
absent-versus-failed, and about a run without a score is unchanged and is inherited here.

## Context

NapBench answers "did the model implement the requested functionality?". Every funded run in
`docs/napbench-*.md` was scored that way, and it has turned out to be the wrong question.

The `visual` category shipped in v1 as a port with two trivial implementations and a `not_run`
default. It is weighted 15 and has never produced a number, so a live run is scored on `functional`
50, `browser` 25 and `code` 10, renormalised. **An application that does exactly what was asked and
looks terrible scores 85.** Nobody shipping to a real user would call that a good result, and a
benchmark that does is measuring the wrong thing confidently.

The obvious repair — build the visual judge ADR-0002 assumed and let the 15 finally land — does not
fix it. A run perfect on the other three categories and scoring **zero** on `visual` still comes out
at 85, because that is what 50 + 25 + 10 out of 100 is. **A weighted mean lets correctness buy the
rest.** Whatever weight is put on appearance, the majority weight on functionality pays for it, and
the only way to make appearance decisive under a mean is to weight it so heavily that it stops being
the minority claim it honestly is.

The mirror problem was already solved. A beautiful application that does not work cannot score well,
because the gate ladder fails a run whose preview never serves and caps a failed build at 40. What
was missing was only the other direction.

## Decision

A run's score is **two halves, combined geometrically**:

```
overall = round(√(objective × product))
```

- The **objective half** is ADR-0002's four-category weighted mean, unchanged — same categories,
  same weights, same renormalisation, same gates. Nothing about a v1 score's arithmetic moves.
- The **product half** is a judge's grades over nine equally weighted dimensions, folded to one
  0–100 number. How those grades are arrived at is [ADR-0013](0013-product-quality-is-graded-ordinally-from-screenshots.md);
  this ADR is only about the arithmetic they feed.

What that buys, in the four corners:

```
correct 95, beautiful 90  →  92
correct 95, ugly      25  →  49
broken  30, beautiful 90  →  52, and then capped at 40 by the build gate
broken  30, ugly      25  →  27
```

**Neither half can carry the other.** That is the whole property, and it is the reason for a
geometric mean rather than a differently-weighted arithmetic one: under a product, a weak half drags
a strong one down towards it instead of being averaged away, and no amount of one half buys the
other. Correct-and-ugly lands at 49 rather than 85.

### Which arithmetic produced a number is recorded on the report

Both models land on the same 0–100 scale, which is exactly what makes them dangerous side by side.
So every report carries a **scoring model**, `v1` or `v2`, and **`compare` refuses a v1 baseline
against a v2 candidate.** This is where comparison parts company with its treatment of a differing
harness identity: a differing harness is *printed* because "what did V2 do to the score?" is a real
question, and there is no question a v1-against-v2 delta answers.

An unrecorded scoring model reads as `v1`, applied by `scoringModelOf` rather than by a schema
`.default()`, so a report written as v1 and one predating the field stay distinguishable on the way
back out. The file goes on saying exactly what it said.

### An unjudged run is scored on the objective half alone

Not on a product half of zero. Every free run has no judge, every real run has none until a vision
adapter exists, and the entire archive predates the concept. Absence renormalises — which here means
the product term drops out and the objective half *is* the score — exactly as ADR-0002 has an absent
category renormalise.

There is deliberately no code path that returns a product half of zero. `scoreProduct` returns
`undefined` both when the judge did not run and when it ran and found every dimension unassessable,
because a mean over an empty set is an absence and not a low score. `combineHalves` takes the
product half as optional and returns the objective one untouched when it is missing.

### What makes a task judged is the task, not the run

A task declares an **intent** — one neutral sentence about what the application is for. A task that
declares one is scored on two halves; a task that declares none is scored on its checks alone
*whatever judge is composed*. That is what keeps the frozen `all` suite priced as its three funded
runs priced it, without a flag anybody has to remember to leave off.

### `visual` is retired, and the name is kept

Nothing scores into the `visual` category any more. The name stays in the schema, the glossary and
the category list because every archived report names it — in its categories and in its effective
weight vector — and removing it would make files unreadable by the code that wrote them. On any
recent report it is simply absent, which renormalises.

### The gates still arbitrate

The gate ladder runs on the combined number, not on either half. A judge cannot rescue an
application that does not compile: `build_failed` still caps at 40, `preview_not_started` still
fails the run, and every gate fires before or above the arithmetic. The judge grades a separate half
and arbitrates nothing.

## Consequences

**v2 numbers are lower than v1 numbers for the same work, and that is the point.** A reader
comparing a new report against a write-up in `docs/napbench-*.md` will see a drop that is entirely
the scoring model. This is the cost of the change and it is paid once; `compare`'s refusal is what
stops it being paid silently and repeatedly.

**Two suites, two arithmetics.** `all` keeps its four tasks, its four categories and its linear
mean forever. The `product` suite is a separate list whose tasks declare an intent. A task in both
would be quoted under two arithmetics, so no task is in both.

**A number can sit far below the half a reader was looking at.** An application whose checks all
passed reports an objective half of 95 and an overall of 49, which is startling if the product half
is not read first. The report keeps both halves explicitly beside the overall, in that order, so the
number can be recomputed by hand rather than taken on trust.

**The reward projection carries the halves.** `rewardFor` emits `objective` and `product` as named
metrics alongside `overall`, because a consumer plotting reward over time needs to see *which* half
moved — which is the distinction this whole change exists to make.

## Alternatives considered

**Reweight the categories so `visual` dominates.** Make appearance 50 and functionality 30. Rejected
because it inverts the honest ordering — an application that does not do what was asked *is* a
failure however it looks — and because it does not remove the buying: at any weight vector, a strong
functional score still purchases a mediocre overall.

**A minimum rather than a product: `overall = min(objective, product)`.** Strictly harsher and
arguably more honest — a product is as good as its worst half. Rejected because it discards
information: two runs at (95, 25) and (30, 25) would score identically, and the first is plainly a
better result to have obtained. A geometric mean is monotone in both halves, which a minimum is not.

**Keep one number and add the product half as a fifth category.** The smallest change, and it fits
the existing renormalisation with no new arithmetic. Rejected because it is the failure mode
restated: a fifth category is a fifth weight, and a fifth weight is bought by the first.

**Refuse an overall score at all and report two numbers.** The most rigorous option, and the one
with no arithmetic to defend. Rejected for the reason ADR-0002 rejected it: the CLI summary,
`compare` and any reward projection all need one figure to rank by, and a benchmark nobody can quote
a number from is a benchmark nobody uses.
