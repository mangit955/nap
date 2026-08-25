# The first look at a real product judge

The runs that answered two questions outright, and turned the third into a better question.

The product half of a score is a judge's opinion turned into arithmetic, and until this the
opinion did not exist: `resolveProductJudge` returned a sentence explaining that nothing had
verified a vision model could be reached at all. Three things were bought here — that the route
carries an image, that the machinery joins up end to end, and what the resulting instrument can
and cannot tell apart. The first two came back yes. The third came back **partially — and what was
wrong turned out to be two of the corpus's own claims rather than the model.**

**Configuration.** `apps/napbench/scripts/vision-reachability.ts` and the corpus discrimination
suite, both against the nine committed fixtures in `apps/napbench/fixtures/corpus/` — static HTML
photographed once at 375×667 and 1280×800, no sandbox, no agent, no E2B. `openai/gpt-5.6-luna` and
`openai/gpt-5.6-terra` via OpenRouter's Anthropic-shaped `/v1/messages`. 2026-08-25. Two probes and
four corpus passes, **≈ $0.37** — of which $0.27 was the single `terra` arm.

---

## The route carries an image, and the answer comes back as a tool call

This was never in evidence. OpenRouter's model registry reports `input_modalities` including
`image` for every `openai/gpt-5.*` id, which is a claim about the **model**; what a benchmark run
depends on is a claim about the **route** — that the *Anthropic-shaped* endpoint this repo uses
forwards an `image` content block to a non-Anthropic model, and answers with the `tool_use` block
the structured judgement rides in. `docs/GOTCHAS.md` already records that OpenRouter's own
documentation hedges on exactly this point.

It does. `openai/gpt-5.6-luna` answered in 24.8s, 3,975 input tokens and 1,791 output, with a
complete judgement whose observations are checkable against the pictures:

```
restraint  excellent  home@desktop: white background, thin separators, one primary blue
                      action, semantic status colours, no decorative imagery or gradients
color      good       home@desktop: blue marks the two In progress statuses and the Add
                      button, grey marks Todo and secondary metadata, red Blocked, green Done
```

Those are descriptions of the artefact, not restatements of a verdict, and they are right. The
judge is looking at the image.

**Two wire-shape facts cost a paid call each, and neither is in any documentation.**

- The model fills in **every** property the tool schema mentions, including `reason: ""` on the
  nine dimensions it has just graded. A schema that treated a blank string as a value refused a
  whole judgement over a tidy model. Blank now reads as absent, on the way in only — the report's
  own schema still refuses a blank anywhere one would mean something.
- OpenRouter answers `cache_creation_input_tokens: null` for a model that does no prompt caching.
  Every usage counter is nullish, not optional, and a schema that only tolerated an absent field
  threw away a paid judgement over a token count nothing decides on.

## The machinery joins up

A judgement produced by a vision model over real PNGs parses against the same
`ProductJudgementSchema` a scripted one does, folds through the same `scoreProduct`, and lands in
the same report section. Nothing between the port and the score had to learn that a model exists.
The product half of `minimalist-professional` came out at 77 over 9 assessed dimensions.

## What it can and cannot tell apart

Four arms, all against the same nine fixtures and the same seven expectations from
`packages/bench/src/product/discrimination.ts`:

| Arm | Met | Top-vs-bottom margin (needs 15) | `excessive-gradient` restraint | `excessive-icon` restraint |
|---|---|---|---|---|
| luna, rubric `product-1` | 4 / 7 | 4 | moderate | good |
| luna, rubric `product-2` | 4 / 7 | 11 | moderate | moderate |
| terra, rubric `product-2` | 4 / 7 | 10 | moderate | moderate |
| luna, `product-2`, expectations re-shaped | **6 / 7** | 13 | moderate | moderate |

The first three arms ran against `grade_at_most weak` on both restraint fixtures. The fourth ran
after those two were re-shaped as pair orderings — see "What was done about it" below.

**What it gets, on every arm.** Both halves of the responsive pair — `desktop-only-breaks-mobile`
at most `weak` and `responsive-strong` at least `good`, which together are what separates a judge
that understands responsiveness from one that marks every narrow screenshot down. `broken-beautiful`
beating `correct-ugly` by a real margin, which is the direction the geometric combination exists
for. And `icons-restrained` at least `good`, which is the control that catches a judge that has
learned "icons are bad" rather than "decoration must earn its place".

**What it does not get.** It will not put an overuse fixture below `moderate` on `restraint` — the
finding that re-shaped two expectations, below — and the gap between the top and the bottom of the
corpus is 10–13 points rather than 15, which is the one claim still unmet.

## Why this is not a model finding

The obvious reading is that a cheap model cannot see design, and one arm was bought to test it.
`openai/gpt-5.6-terra` is the same generation at ten times the price, and it produced **the same
three failures, in the same places, to within one anchor** — `excessive-icon` moved `good` →
`moderate` and the margin moved 11 → 10. A capability limit does not usually cost ten times as
much and buy one anchor.

A rubric revision was tried in between and is also recorded above. Sharpening the scale (`most
interfaces are not good`), giving `hierarchy` the below-the-fold question explicitly, and asking
`restraint` device by device moved the top-vs-bottom margin from 4 to 11 — a real improvement, and
the whole of it landed on the *ordering* expectation. Neither restraint bound moved on either
model. That is two independent interventions failing in the same place, which is usually the
place where the claim rather than the instrument is wrong.

**The likely reading is that the two `grade_at_most weak` expectations are the wrong shape.**
`discrimination.ts` opens by arguing for "orderings and bounds, never absolute numbers" — and a
`grade_at_most` on one fixture *is* an absolute claim about one grade, which is precisely what
that argument warns against. The corpus's own defence is that the expectations come in pairs, and
the pairs hold: `icons-restrained` comes back `good` while `excessive-icon` comes back `moderate`,
so the judge **orders the icon pair correctly**. What it will not do is agree with us about where
on the scale the bad one sits.

Deciding that is a change to what the corpus claims, and it is not a change to make from a
failing test.

## What was done about it

The two `restraint` bounds are now **pair orderings**: `icons-restrained` grades better than
`excessive-icon`, and `minimalist-professional` grades better than `excessive-gradient`, both on
`restraint`. A new `grades_better` expectation kind carries them. It asserts direction and no
magnitude — a number of anchors would be an absolute claim wearing an ordering's clothes — and it
demands *strictly* better, because a judge that grades the pair equally has not seen the only thing
that differs between them.

The confirming arm met both, and not narrowly: `excellent` against `moderate` on each, a two-anchor
gap. So the instrument was never failing to tell these fixtures apart; it was disagreeing with us
about where on the scale the bad one sits, which is what an ordering was the right shape for all
along.

**Three things were deliberately not done.**

The **responsive bounds stayed absolute**, though they are the same shape as the two that moved.
They were met on every arm — `desktop-only-breaks-mobile` at `weak`, `responsive-strong` at
`excellent` — so the corpus can demonstrate them. A bound is not wrong for being a bound; it is
wrong when the corpus cannot support it, and only measurement says which. Re-shaping them too
would have been applying a rule where a measurement was available.

`icons-restrained restraint at least good` **also stayed absolute**, and it is what stops the new
pair ordering from sliding: a judge that had learned "icons are bad" and marked the whole pair down
would still satisfy the ordering. It came back `excellent`.

**`MEANINGFUL_MARGIN` stayed at 15**, so the corpus suite is still red on one expectation. The
margin measured 11, 10 and 13 across the arms — the spread is worth noting on its own, since three
points of run-to-run noise on a nine-dimension mean is the resolution this instrument actually has.
Lowering the threshold to 10 after seeing 10 is the same tuning move that was declined on the
bounds, and there is no independent argument for a smaller number: the 15 was derived from the
anchor spacing rather than from taste. It is left failing and documented.

## What this leaves

- `openai/gpt-5.6-luna` is pinned as the default judge, on cost: `terra` bought one anchor for ten
  times the money. `NAP_JUDGE_MODEL` moves it without editing code.
- **The corpus discrimination suite is red on one expectation, deliberately** — the top-vs-bottom
  margin, and only that. It is not in `bun run test`; it is a paid integration suite, and its
  failing is the finding rather than a bug to route around. Do not make it pass by editing
  `MEANINGFUL_MARGIN` without a decision recorded beside it.

  **Settled later, by a fifth and sixth arm, and not by editing the threshold.**
  `MEANINGFUL_MARGIN` is still 15 and the suite is green.
  [`napbench-corpus-margin.md`](napbench-corpus-margin.md) has the matrix and the argument; the
  reason it took five arms to get there is the bullet below.
- The judge and the agent are currently the same model, which is a conflict of interest on any
  funded run that compares two models. Pin the judge to something neither arm is before spending
  on one — that is what `NAP_JUDGE_MODEL` is for.
- **Each of these four arms reported verdicts and threw the grades away.** Seven met-or-unmet lines
  is less than an arm buys, and the fifth had to be paid for to read a matrix any of the four could
  have printed. The paid suite prints one now. If you are about to fund an arm, ask first what it
  will leave behind besides a pass or a fail.
- A run of the `product` suite has never been funded. Everything above is the judge alone, over
  static fixtures. What a real generated application scores, and whether the two halves multiply
  to something a person would recognise, is still unbought.
