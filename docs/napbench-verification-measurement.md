# The funded before/after measurement

What the verification loop is worth, measured rather than claimed — and what the measurement
found instead, which is that on this task the loop cannot see the only thing that broke.

**Configuration.** The `hard` suite (one task, `expense-ledger`), n=3 per arm, two arms differing
only in the runtime's `verification` setting: `trust` (v1's behaviour, `--no-verify`) against
`arbitrate`. `openai/gpt-5.6-terra` via OpenRouter at medium effort, 40 steps and 120k context
tokens per turn, real E2B sandboxes, browser checks driven from a real Chrome on the host. Both
arms ran from commit `5f955072` with a clean tree, and every report records that harness identity.
2026-08-17. Six runs, $0.134 in total.

---

## The headline

| Arm | Runs | Passed | Mean | Median | SD | Range |
|---|---|---|---|---|---|---|
| verification **off** | 3 | 3 | 100.0 | 100.0 | 0.0 | 100–100 |
| verification **on** | 3 | 2 | 98.0 | 100.0 | 3.5 | 94–100 |

The spread is per task, which here is the whole suite — `hard` is one task. There is no
suite-level standard deviation quoted anywhere in this document, and there should not be: with
one task it would be the same number wearing a more impressive name.

**The loop did not help, and the arm that ran it scored lower.** That is the honest headline, and
the rest of this document is why it is not the finding it looks like.

## Two things went wrong with the experiment, and both are worth more than the number

### 1. The control arm ceilinged

`expense-ledger` was built to separate two *models*. On `gpt-5.6-terra` it does not separate
anything: three runs out of three passed every one of eleven checks on the first turn, with zero
spread. A control arm at 100 leaves the treatment arm nowhere to go — no measurement of
improvement was available to be taken, whatever the loop does.

So the -2.0 in the table is not the loop costing two points. It is one run in six landing on a
type error, in an experiment with no headroom in the other direction. At n=3 with an SD of 3.5,
that difference is indistinguishable from the variance.

The model choice caused this. The tasks were calibrated against `gpt-5.6-luna`; `terra` is ten
times the price and clears them.

### 2. The loop is blind to the check that broke

This is the real finding, and it is structural rather than statistical.

The one failing run, `b647cb08`, failed on `typecheck — exit 1`. Its trajectory shows the
verification loop ran, and shows what it concluded:

```
typecheck  absent
lint       absent
build      passed
test       absent
preview    passed
→ job.completed { outcome: "verified" }
```

Identical in all three verification runs. Three of five checks were **absent**, no repair turn
ever fired, and the job that did not typecheck was reported `verified`.

The cause is a disagreement about what a check is. `@nap/verify`'s `discover-checks` finds checks
by reading the project's `package.json` and looking for a *script* of that name — reasonably, since
a script nobody declared is absent rather than failed. The sandbox template declares no `typecheck`
script and no `lint` script. NapBench already knows this: the first funded run discovered it the
expensive way, and every task since invokes `bunx tsc --noEmit` directly for exactly this reason
(see [`napbench-first-real-run.md`](napbench-first-real-run.md) and the comment on the check in
`packages/bench/src/tasks/landing-page.ts`).

So on this template the loop arbitrates two checks — `build` and `preview` — and `build` passes on
code that `tsc --noEmit` rejects, because Vite does not typecheck. The grader looks harder than the
guard. **A repair turn was never possible for the only defect that occurred in six runs.**

That the fakes could not catch this is the same shape of gap as last time: an in-memory sandbox has
no `package.json` to discover checks from, so a dry run never reaches the question.

## Per-check movement

The only check that moved anywhere in six runs, via `napbench --baseline=… --candidate=…`:

```
expense-ledger — 7132f2e7 → b647cb08
  harness      5f955072, verification off → 5f955072, verification on
  overall      100 → 94 (-6)
  functional   100 → 100 (0)  weight 58.8%
  browser      100 → 100 (0)  weight 29.4%
  code         100 → 50 (-50)  weight 11.8%
  checks that moved
    ✗ typecheck — passed → failed (broken)
```

Nothing else moved in either direction, per category or per check. Every functional and browser
check passed in all six runs.

**What got worse:** the `code` category on one verification run, and the suite's success rate with
it, 100% → 66.7%. Attributing that to the loop would be wrong — the loop never examined the check
that failed — but it is recorded here rather than explained away, because a measurement that only
reports the movements it likes is not a measurement.

## Cost of the loop

| | off | on |
|---|---|---|
| mean turn time | 21.9s | 23.6s |
| mean tokens in / out | 10,291 / 1,984 | 10,017 / 2,079 |
| mean cost per run | $0.0222 | $0.0225 |
| repair turns fired | — | 0 |

Within noise, and for the reason above: with no check failing that verification could see, the loop
cost one round of `build` and `preview` and nothing else. **This is not an estimate of what the loop
costs when it works** — a run that fires two repair turns costs roughly three times the tokens, and
none of these did.

## What this measurement licenses being said

- That the verification loop runs end to end against real infrastructure, arbitrates a turn's
  claim, and checkpoints the job. Six runs, no infrastructure errors.
- That on `expense-ledger` / `gpt-5.6-terra` it changed no outcome, in either direction, that can
  be distinguished from run-to-run variance at n=3.

It does **not** license any claim that verification improves scores. Nothing here measured that,
and the next attempt has to fix two things first: run against a model the task actually separates,
and close the gap between what `@nap/verify` discovers and what the template declares.

## Follow-ups

- ~~The discovery gap: the template declares no `typecheck` or `lint` script, so the loop is blind
  to both on every project it will ever build from that template.~~ **Closed (#54):** the template
  declares `"typecheck": "tsc --noEmit"`, so discovery finds it and the loop arbitrates it.
  Discovery itself is unchanged — a script nobody declared stays *absent* rather than falling back
  to a binary, which keeps that word meaning what `discover-checks.ts` says it means. `lint` is
  still absent and honestly so: the template ships no linter. **Live as of 2026-08-17**, when
  `nap-vite-react` was republished (build `ae11c9f7`) and the integration case that runs
  `bun run typecheck` inside a real sandbox passed against the new image. Projects created from
  the older image keep the old manifest in their git history and stay blind until recreated.
- Re-run the measurement on `gpt-5.6-luna`, which the tasks were calibrated against and which
  leaves the headroom this pairing did not have. Six runs is roughly $0.02 at that rate.
