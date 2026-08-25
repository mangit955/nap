# ADR-0013 — Product quality is graded ordinally, from screenshots alone, by a pinned judge

**Status:** Accepted — 2026-08-25
**Depends on:** [ADR-0012](0012-the-score-becomes-two-halves-combined-geometrically.md), which decides
that a product half exists and how it combines with the objective one. This ADR decides how the
number in it is arrived at.

## Context

The product half needs a judge, and a judge is the first thing in NapBench that produces a number
nobody can check by re-running a command. Every other figure in a report decomposes into a check
that passed, failed or was absent. This one decomposes into an opinion.

Three ways that goes wrong, and they are the three this ADR is about.

**It overfits.** A judge shown the source can reward a stack, a component library or a file layout
that has nothing to do with whether the result is good — and the agent under test would then be
graded on writing code that judges well rather than on producing a product.

**It drifts.** A judge asked for a number invents precision it does not have. The same screenshots
scored twice come back 68 and 79, and a reader cannot tell that from a real movement. A benchmark
whose instrument moves under it is measuring itself.

**It cannot be checked.** An evaluator nobody has watched discriminate is a check that has never
been observed failing. A judge returning `moderate` to everything produces reports that look exactly
like a judge that works.

## Decision

### The judge sees screenshots and one sentence of intent, and nothing else

No source, no `package.json`, no file tree, no prompts. What it gets is the images from the capture
pass — declared **surfaces**, each photographed at mobile and desktop, at most four surfaces and so
at most eight images — and one neutral sentence saying what the application is *for*.

**Screenshots-only is the anti-overfitting defence**, and several properties fall out of it for
free rather than needing rules:

- **Library-blindness.** The judge cannot know whether a dialog is shadcn, Radix or hand-rolled, so
  it cannot reward a choice of dependency. It can only see whether the dialog is any good.
- **No credit for a tidy repository.** Nothing about how the code is organised is visible, so
  nothing about it can be graded. The objective half already audits what the code is worth.
- **Defaults still lose points.** An application shipping a library's unmodified defaults is not
  invisible to this — it looks assembled, and looking assembled costs `restraint` and `components`
  without the judge ever knowing what was installed.

**The prompts are withheld deliberately.** A person opening the finished application has no
specification in front of them, and that is the question being asked. Handing over the prompts would
also blur the halves: the judge would start grading feature completion, which the objective half
already measures and measures better, because a check cannot be talked round. The intent exists only
because information density means different things for a ledger and for a landing page.

### Grades are ordinal, and the numbers are applied afterwards, by us

Five points, best to worst, with fixed anchors:

| Grade | Anchor |
|---|---|
| `excellent` | 95 |
| `good` | 78 |
| `moderate` | 55 |
| `weak` | 35 |
| `poor` | 12 |

**Ordinal-over-numeric is the anti-drift defence.** Asked whether typography is `weak` or
`moderate`, a judge is making a judgement a reader can check against the evidence it cited. Asked
for `73`, it is inventing a resolution it does not have. The anchors turn the judgement into
arithmetic *afterwards*, in our code, where the mapping is fixed, inspectable and versioned rather
than re-improvised per run.

The anchors are not evenly spaced, and both ends are deliberate. `excellent` is 95 rather than 100
because nothing rendered is beyond criticism. `poor` is 12 rather than 0 because a page that draws
something badly is not worth the same as a page that draws nothing — the *gates* are what punish an
application that does nothing, and a floor of zero here would let one bad dimension swamp eight good
ones.

**Nine dimensions, equally weighted, and `polish` reported but never scored.** Equal weights because
any weighting we chose would be our own aesthetic theory compiled into the instrument, and the brief
this was built to forbids favouring a design approach. `polish` — the holistic read — is excluded
*structurally*, by not being a member of `PRODUCT_DIMENSIONS`, because a rule can be forgotten and a
list cannot: every consumer folds over that list. Averaging it in would double-count, since it is a
summary of the nine, and would let the least evidence-anchored thing the judge produces dominate
nine grounded grades. Its value is the disagreement.

**There is no icon dimension.** Naming one would bake a component library into the rubric and make
the benchmark measure adherence to our taste. Icon usage is judged under `restraint`, which asks
whether a decision earns its place — the same question a gradient, a shadow or a card has to answer
— and the rubric requires it to be *stated* there on every run so it stays visible even when the
answer is "fine". For the same reason, slop is not a penalty list: a gradient can be good design
used intentionally, and the question is always whether the decision improves the product.

### The schema refuses what a prompt can only request

- **A grade without evidence is refused.** Every graded dimension carries at least one observation
  naming the screenshot and viewport it was drawn from. "typography: weak" is an opinion;
  "typography: weak, because on `home@mobile` the heading and the body differ only in weight" is an
  argument. Enforced in the schema rather than asked for in the rubric, because a prompt is a
  request and a schema is a refusal.
- **Every dimension must be answered.** A silently missing one shrinks the denominator, and a
  shrinking denominator raises the score.
- **`not_assessable` is absence, not a sixth grade.** It carries no number, is kept out of `GRADES`
  so no exhaustive map can give it one, and requires a stated reason. A judge that could not see a
  surface must not be able to lower a score by saying so — the same distinction ADR-0002 draws
  between an absent category and a failed one, renormalising for the same reason.

### The judge is pinned, and every judgement says which one it was

A judgement records a **judge identity**: a `source` and a **rubric version**. The rubric version is
there because the same model against a reworded rubric is a different instrument, and a score taken
under one is not a score taken under the other — so it belongs with the judgement rather than with
the run's configuration.

`source` is a free string — `manual:<somebody>`, or a model id — rather than an enum, because an
enum would have to be widened by `packages/bench` every time somebody plugged in a new judge, which
is the coupling the port exists to avoid. **No model is named by this ADR.** Nothing may pin a
vision model until it is verified that the model accepts image input through the OpenRouter path
this repo uses; `LLMContentBlock` has no image variant today.

The judge is a port (`ProductEvaluation`), not the agent's `LLMProvider` — that is the thing under
test, and `packages/bench` may import only `@nap/shared` and `@nap/verify` in any case. The adapter
lives in `apps/napbench`, exactly as `BrowserSession`'s does.

### Single-judge bias is accepted, and disclosed

One model grading nine dimensions has that model's aesthetic preferences in it. A panel of three
judges with disagreement reported would be better evidence and costs three times as much per image,
on a benchmark whose entire funded history is $0.15.

**So this is a known, accepted limitation and it is stated wherever a product score is quoted.** The
mitigations are what make it tolerable rather than what remove it: the grades are ordinal so the
bias is at least stable; the evidence requirement means a reader can disagree with a specific claim
about a specific image rather than with a number; the judge identity is recorded so a score is
always attributable; and the fixture corpus measures whether the judge discriminates at all.

### The judge is checked against a fixture corpus

Nine hand-written applications, all rendering **the same content** with the same one sentence of
intent, so design is the only variable between two of them — committed as pages plus photographs,
and never run as a benchmark task.

**What is asserted are orderings and bounds, never absolute numbers.** "Minimalist beats slop by at
least a real margin"; "`restraint` on `excessive-gradient` is at most `weak`". Asserting a fixture
scores 62 would be this repo's *never assert on model prose* rule broken in numeric form: an exact
anchor is the judge's phrasing, and a run one grade lower on two dimensions would fail a test having
discriminated perfectly well.

Each claim is one half of a **pair**, which is what makes it a test of discrimination rather than of
severity: a judge that marks every icon down passes the `excessive-icon` bound alone and fails the
moment `icons-restrained` has to come back `good`. And the free suite runs the claims against a
scripted judgement that grades every fixture identically, which must fail all of them — because that
is the failure mode the corpus exists to catch.

## Consequences

**A product score is only comparable within a judge identity and a rubric version.** Reword the
rubric and the archive is on the far side of a line, exactly as the scoring model draws one.

**The rubric is now a versioned artefact with a compatibility cost.** Adding a dimension changes
every denominator; renaming one invalidates stored judgements against a strict schema. Neither is
forbidden — both have to be a deliberate version bump.

**A run that photographed nothing has no product half.** An unreachable surface, an absent browser
and a full disk each cost the run images, and enough of them cost it the half entirely. That is
absence and it renormalises to the objective half alone; it is never a zero.

**Every image is vision-model tokens on every real run**, which is why the capture pass is bounded
at four surfaces and eight images by the task schema rather than by anybody remembering.

## Alternatives considered

**Ask the judge for a number out of 100.** One fewer mapping to defend, and finer resolution.
Rejected as the drift failure above: the resolution is invented, and it is invented differently each
run.

**Show the judge the source as well.** Strictly more information, and it would let the rubric ask
about code quality directly. Rejected as the overfitting failure: it makes the benchmark gradeable
by writing code that reads well, and it duplicates the `code` category, which measures the same
thing with a tool that cannot be persuaded.

**Show the judge the prompts.** It would let the rubric ask whether what was built is what was
asked for. Rejected because the objective half already answers that with checks, and a judge given
the question would answer it worse and crowd out the question only it can answer.

**A panel of judges, with disagreement reported.** Better evidence and the honest answer to
single-judge bias. Deferred on cost, and disclosed rather than hidden. The port makes it a
composition change if the budget ever exists — nothing in `packages/bench` would need to move.

**Compare against reference screenshots instead of judging.** Deterministic, free and repeatable.
Rejected because there is no reference for a generated application: what a to-do app *should* look
like is the thing under measurement, and a reference would grade similarity to one designer's answer
rather than quality.
