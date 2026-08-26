# The slop is gone and the habit replaced it

The first funded run of the `product` suite against applications Nap actually generated — and the
first evidence that the two halves multiply to something a person would recognise.

Everything before this was the judge alone over the nine static fixtures in
[`napbench-vision-judge.md`](napbench-vision-judge.md) and
[`napbench-corpus-margin.md`](napbench-corpus-margin.md). Those arms established that the
instrument discriminates. They could not say what a real generated application scores, because no
real generated application had ever been put in front of it.

**Configuration.** `bun run napbench --real --suite=product`, 2026-08-26, harness commit
`448460a`, tree clean, verification on. Agent `openai/gpt-5.6-luna` via OpenRouter at medium
effort, 40 steps, 120k context. Judge `openai/gpt-5.6-terra` via `NAP_JUDGE_MODEL`, rubric
`product-2`. Real E2B sandboxes, real Chrome. Three tasks, serially, one turn each.

**Spend ≈ $0.09.** Agent **$0.0123** measured (`$0.0048` + `$0.0045` + `$0.0030`, price table
`2026-08-17`); judge and the terra reachability spike ≈ **$0.08**, estimated rather than measured,
for the reason in *What this run could not account for* below.

---

## The scores

```
task                hier typo spac colo layo comp inte resp rest    obj  prod  overall
reading-list        G    G    G    G    G    G    G    G    E       100    80       89
sales-dashboard     G    G    G    G    G    G    M    G    E        90    77       83
pricing-page        W    G    G    G    M    G    M    G    G       100    68       82
```

`polish` came back `good` on all three — within one anchor of each computed product half, so the
rubric is not obviously missing a dimension. That is the disagreement signal working as
[ADR-0012](adr/0012-the-score-becomes-two-halves-combined-geometrically.md) intended, and reporting
nothing is the correct outcome for it.

Mean 84.7 over three counted runs, two passed, one failed, **zero agent errors and zero
infrastructure errors**. Every task produced a score; nothing was withheld.

## The question this was bought to answer

The map that built all of this, #101, opened by saying that an application which does exactly what
was asked and looks terrible scored 85, and that this is not a result anybody shipping to a real
user would call good. The system prompt learned about design (#108), the template got tokens and
primitives (#107), and the rubric got `restraint` (#102). None of that had been put in front of a
real generated application.

**It works.** `restraint` came back `excellent`, `excellent`, `good`, and the evidence is grounded
rather than flattering:

> "no ornamental cards, illustrations, or superfluous effects are present… the only graphic marks
> are data-bearing blue drink bars" — `sales-dashboard`, desktop

> "Icons are used sparingly: the header contains one book symbol, while article completion is
> represented by simple unfilled circles rather than an icon-heavy row." — `reading-list`, desktop

The screenshots were opened and agree with the grades. There are no gradients, no card soup, no
icon spam, no unmodified library defaults. The generated applications are editorial white pages
with fine dividers, one restrained accent, and real type hierarchy. The gradient/card/Lucide house
style the map was written to eliminate did not appear once in three applications.

## What replaced it

**All three tasks drew the same weakness, independently, and it is not the one anybody was looking
for.**

> "The oversized hero is a stronger editorial gesture than the otherwise highly utilitarian
> interface needs." — `reading-list`

> "The oversized empty hero area reads as minimalism applied beyond what the task warrants."
> — `pricing-page`

On the pricing page this is not cosmetic. It is the whole reason `hierarchy` graded **weak**, the
only weak grade in the run, and the judge's reasoning is checkable against the image:

> "The page spends a large upper area on the brand statement and introductory copy; the workspace
> choice begins much lower, and pricing cards only start near the bottom of the viewport."

The plans are the point of a pricing page, and they start at the bottom edge on desktop and are a
sliver on mobile. A person landing on it has to scroll before seeing the thing they came for.

**The failure mode inverted rather than disappeared.** The old one was decoration applied
indiscriminately; the new one is *restraint* applied indiscriminately — a magazine hero on a
utility screen. Both are the same underlying error, which is applying a style rather than asking a
question, and the second is harder to see precisely because each individual decision is defensible
and the result photographs well.

This is worth being exact about, because it is the kind of finding that gets rounded off into "the
prompt needs tuning". The design brief in `system-prompt.ts` argues for intentionality and
deliberately does not forbid anything — that was decided in #108 and it was the right call. What
it never says is anything about **proportion to the task**: how much of a screen an introduction
has earned depends on what the screen is for, and a reading list, a dashboard and a pricing page
have three different answers. The brief gives one.

**No change was made here.** Three applications is three, the hero appears in all three, and the
obvious next step is a control arm that separates "the hero habit is the prompt" from "the hero
habit is luna" before anything in the prompt moves. Changing the brief now would mean the next run
measures a different thing for a reason nobody wrote down — which is the move
[`napbench-vision-judge.md`](napbench-vision-judge.md) declined three times over.

## The two halves disagreed, and the deterministic one won

`sales-dashboard` failed `fits-on-a-phone`: the page is 85px wider than a 375px viewport. The
judge graded `responsiveness` **good** on the same application — and said why, honestly:

> "Only the top portion of the mobile report is shown, so the reflow of the table and drink ranking
> cannot be verified."

The judge sees two photographs of a viewport; the check drives a browser and measures the document.
The mobile view reflows correctly above the fold, which is all the judge was shown, and breaks
below it, which only the check can reach. So the objective half caught what the product half is
structurally incapable of catching, the run failed, and the score still reflects both.

That is exactly the split #101 designed and the first time it has been observed happening on a real
application: *"`expectNoHorizontalOverflow` at mobile stays an objective browser check; 'is the
small viewport designed for or is the large one squashed' is a judgement."* Neither half was
right on its own.

It also means **a judgement of `responsiveness` is bounded by what was photographed**, which is not
a defect but is a limit worth stating: the surface capture defines the judge's evidence, so a
dimension whose failure lives below the fold can only be graded on what the fold showed.

## What this run could not account for

**The judge's tokens are not accounted anywhere.** `estimatedCost` on a report prices the *agent's*
usage against the table in `pricing.ts`; the vision judge is a separate `fetch` in
`vision-judge.ts` that deliberately reuses none of `@nap/agent`, so its spend appears in no report,
no summary and no total. The agent figure for this run is $0.0123 and the true bill is roughly
seven times that. On a corpus pass this was invisible because there was no agent to compare
against; on a funded suite run the report now understates the cost by most of the cost.

That is a real gap and it is not fixed here. It is worth knowing before anybody quotes a
`product` run's cost from its reports, and worth fixing before anybody funds a large one.

**The `NAP_JUDGE_MODEL` warning cries wolf.** It fires on every overridden judge, unconditionally,
including immediately after `napbench:vision-spike` has confirmed that exact model — the check has
no memory of its own verification. It was correct to run the spike (terra answered, schema-valid,
$0.014) and the warning was noise both before and after.

## What this leaves

- **The `product` suite has now been funded**, once, on one model, at one turn per task. What a
  second turn does to these scores is unbought, and the tasks are single-turn by construction.
- **The hero habit is one arm's finding**, not a characterisation. A terra arm would separate the
  prompt from the model for about $0.30, and is the cheapest next thing worth buying.
- **The judge's cost is invisible in the reports.** See above.
- The judge and the agent were deliberately different models here, which is the conflict-of-interest
  discipline `napbench-vision-judge.md` asked for and the first run to actually apply it.
- Nothing in `discrimination.ts`, the rubric, the brief or the template was changed as a result of
  this run. It is a measurement, and it is recorded rather than acted on.
