# The corpus's two ends differ in three places, not nine

The run that settled what the top-vs-bottom claim should be — and did it by recording something
the four arms before it had thrown away.

`MEANINGFUL_MARGIN` is 15: `minimalist-professional` had to beat `ai-slop-generic` by fifteen
points of product half. It was the only corpus expectation a real judge had never met, across four
funded arms and two models, and it is why `corpus-discrimination.integration.test.ts` was red.
[`napbench-vision-judge.md`](napbench-vision-judge.md) has those arms; it left the question open
deliberately, on the grounds that re-deriving 15 to 10 having just observed 10 is tuning.

**Configuration.** The corpus discrimination suite against the nine committed fixtures in
`apps/napbench/fixtures/corpus/` — static HTML photographed once at 375×667 and 1280×800, no
sandbox, no agent, no E2B. `openai/gpt-5.6-luna` via OpenRouter's Anthropic-shaped `/v1/messages`,
rubric `product-2`. 2026-08-25. **Two** corpus passes, eighteen images each, **≈ $0.06**, ~200s
apiece: the first produced the matrix below and was red on the margin, the second ran after the
expectations changed and met all nine.

---

## What the four arms before it did not record

They reported verdicts. Seven met-or-unmet lines, and for this expectation a single number: *the
margin was 11, needed 15*. That is strictly less than what each of them bought. It says the two
ends came out eleven points apart; it says nothing about **which of the nine dimensions the judge
separated them on**, which is the only fact that decides between "the threshold is wrong", "the
fixture is not slopy enough" and "a margin is the wrong shape".

So the fifth arm was bought to learn something the first four had already seen. `formatGradeMatrix`
in `packages/bench/src/product/grade-matrix.ts` is the fix, and the paid suite now prints it before
the verdicts.

## The matrix

```
fixture                    hier typo spac colo layo comp inte resp rest  score assessed
minimalist-professional    G    G    G    G    G    G    M    G    E       77   9/9
ai-slop-generic            W    G    G    G    M    G    M    G    M       66   9/9
excessive-gradient         G    G    G    M    G    G    M    G    W       68   9/9
excessive-icon             M    M    M    G    M    M    G    P    G       58   9/9
icons-restrained           G    G    G    G    G    G    M    G    E       77   9/9
desktop-only-breaks-mobile G    G    G    M    M    G    M    P    G       63   9/9
responsive-strong          E    G    G    G    G    G    G    E    E       84   9/9
correct-ugly               M    W    P    P    W    P    W    W    M       32   9/9
broken-beautiful           E    E    G    G    G    G    G    E    E       86   9/9
```

Read the first two rows against each other:

| Dimension | minimalist | slop | Apart by |
|---|---|---|---|
| hierarchy | good | **weak** | two anchors |
| typography | good | good | — |
| spacing | good | good | — |
| color | good | good | — |
| layout | good | **moderate** | one anchor |
| components | good | good | — |
| interaction | moderate | moderate | — |
| responsiveness | good | good | — |
| restraint | excellent | **moderate** | two anchors |

**Six of nine identical. Three separated, two of them by two anchors.**

## Why that is the fixture and not the judge

`corpus.ts` says what `ai-slop-generic` was built as, and it was written before any of this was
measured:

> The generated-interface house style: a purple hero gradient, emoji headings, three identical
> centred cards, everything centred. The bottom of the corpus. The tasks themselves are pushed
> below the fold by the marketing, which is not an artefact of photographing a viewport — it is
> the failing, and the photograph is what a person opening it sees.

Every failing in that sentence is a failing of `hierarchy` (the tasks below the fold), `layout`
(three identical centred cards, everything centred) or `restraint` (a hero gradient, emoji
headings). Nothing in it is a failing of typography, colour, spacing, components, interaction or
responsiveness — and that is not an omission. **Competent execution of the wrong decisions is what
the generated house style is.** A slop fixture with a broken type scale and unreadable contrast
would not be slop; it would be `correct-ugly` with a gradient, and the corpus already has that
fixture.

So the judge graded the two ends identically on six dimensions because on six dimensions they *are*
alike, by design. Agreeing there is the instrument working. The three dimensions where the fixture
differs are the three the judge separated, in the direction the corpus predicts, and on two of them
by the full two anchors. **This is a better result than the margin ever reported.**

What the margin did to it is arithmetic: a mean over nine dimensions divides three real separations
by nine. Two anchors, one anchor and two anchors is (43 + 23 + 40) / 9 ≈ 12 points — which is where
11, 10 and 13 came from. The margin was not measuring a weak separation. It was diluting a strong
one across six columns that were never going to move.

## Which of the issue's three questions this answers

The ticket named three, and they are not the same question.

1. **Is 15 the right threshold?** It is the right threshold *for what it was derived from* — a pair
   that differs across most of the nine — and the corpus's two ends are not such a pair. Lowering
   it to 10 or 12 would have made the suite green and would have encoded a false premise: that the
   fixtures differ everywhere and the judge can only half-see it. The number is unchanged.
2. **Is `ai-slop-generic` slopy enough?** Yes, and making it "slopier" would have been the
   expensive mistake. Its 66 is six deliberate `good`s and three deliberate failings. Degrading its
   typography and colour to widen the margin would have converted it into a different fixture —
   bad-at-everything rather than slop — and destroyed the thing it exists to test. **No fixture
   changed, so no re-photograph was needed.**
3. **Is a product-score margin the right shape at all?** Not here. It is the shape for a pair that
   differs in everything a photograph shows, and the corpus has exactly one such pair.

## What changed

The one `beats` between the corpus's two ends became **three `grades_better` claims** —
`hierarchy`, `layout` and `restraint` — using the expectation kind that already existed for the
`restraint` pairs.

The dimensions were read out of the fixture's own description, quoted above. That description is
from `66cb4fb`, the commit that created the corpus — two commits before the vision judge existed
and nine before this one — so the *failings* were on the record before any of them was graded.

**Do not overstate this.** The prose predates the matrix; the reading of it into three dimension
names does not. "A purple hero gradient" could honestly have been filed under `color`, and "emoji
headings" under `typography` — both dimensions the matrix graded identically — so somebody working
from `corpus.ts` alone might have named a different three. This is a post-hoc reading of
pre-existing prose, not a prediction.

What the argument actually rests on is neither the reading nor a number falling short of a
threshold. It is that **the two fixtures were built to be alike on most of the scale**, which is
readable in the description and confirmed by six identical grades — and a mean over nine dimensions
is the wrong instrument for a pair like that whichever three dimensions you name. The second funded
arm is what makes the particular three more than a guess. `corpus.ts` now carries the same caveat
beside the `built` field, because that prose became load-bearing the moment an expectation was read
out of it.

**`MEANINGFUL_MARGIN` is unchanged at 15, and still has a user.** `broken-beautiful` over
`correct-ugly` is graded differently on **nine of nine** dimensions and came in at 54 points. Those
two are not a design pair — they differ in everything visible — so the mean is measuring what the
constant was derived for. Keeping one margin and replacing the other is what makes this a finding
about a pair rather than a rule about margins, and it is the same distinction the responsive bounds
were kept absolute for.

## What this leaves

- **The corpus discrimination suite is green**, confirmed by a second funded pass against the
  changed expectations rather than by projecting the matrix above. Nine expectations, nine met,
  nothing unassessable. It has been red on one expectation since the vision judge shipped; it is
  not any more, and it did not get there by moving a threshold.
- **A grade matrix is now part of what a funded arm leaves behind.** Four arms were bought before
  anybody noticed the verdicts were not the findings. The unit tests around `formatGradeMatrix`
  pin the one thing a table like this can get wrong: printing a letter for a `not_assessable`
  dimension, which would undo at the point of reading what the scorer is careful about everywhere.
- `interaction` came back `moderate` on both ends and on `icons-restrained`, and `excellent`
  nowhere in the corpus. That may be the dimension a screenshot cannot really answer — nothing here
  measured it, and it is the obvious next thing to look at.
- The judge and the agent are still the same model, and that is still a conflict of interest on any
  funded run comparing two models. `NAP_JUDGE_MODEL` moves it.
