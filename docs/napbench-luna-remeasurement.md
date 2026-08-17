# The re-measurement on the model the tasks were calibrated against

The second funded attempt to measure what the verification loop is worth, run after the two
things that spoiled the first one were fixed: the template now declares the `typecheck` script
the loop discovers, and the model is the one `expense-ledger` was built to separate.

One of those fixes worked. The measurement still did not.

**Configuration.** Identical to
[`napbench-verification-measurement.md`](napbench-verification-measurement.md) except the model:
the `hard` suite (one task, `expense-ledger`), n=3 per arm, `trust` (`--no-verify`) against
`arbitrate`. `openai/gpt-5.6-luna` via OpenRouter at medium effort, 40 steps and 120k context
tokens per turn, real E2B sandboxes, browser checks from a real Chrome on the host. Both arms ran
from commit `1876464` with a clean tree, against template image `nap-vite-react` build `ae11c9f7`
— the first republished image that carries the `typecheck` script. 2026-08-17. Six runs, $0.0153.

---

## The headline

| Arm | Runs | Passed | Mean | Median | SD | Range |
|---|---|---|---|---|---|---|
| verification **off** | 3 | 1 | 81.3 | 94.0 | 27.3 | 50–100 |
| verification **on** | 3 | 2 | 98.0 | 100.0 | 3.5 | 94–100 |

**Do not quote the +16.7.** It is one catastrophic control run, and the section below shows the
loop could not have prevented it. The arms are 94/50/100 against 100/94/100; the difference is
which arm happened to draw the bad run.

## What actually got fixed

The structural defect the last measurement found is gone. Every verification-on trajectory now
reads:

```
typecheck  passed
lint       absent
build      passed
test       absent
preview    passed
→ job.completed { outcome: "verified" }
```

`typecheck` was `absent` in all three runs last time, on every project the template could produce.
It is arbitrated now, confirmed in a real run rather than inferred from the manifest. `lint` and
`test` stay `absent`, which is correct — the template declares neither, and a check nobody
declared is not a check that failed.

That is the whole of what these six runs established, and it is worth the $0.0153.

## Why the number still says nothing

### The one run that separated the arms is invisible to the loop

Control run `ad842442` scored 50: five of nine functional and browser checks failed — list items
never rendered, pagination clicks timed out at 15s. Its other two checks:

```
build      passed  (exit 0)
typecheck  passed  (exit 0)
```

Its `code` category scored 100. So had verification been on for that run, the loop would have
found every runnable check passing and reported the job `verified` — exactly as it did for the
three runs that scored 100. **The loop cannot see a React app that compiles, builds and serves
while rendering the wrong thing.** Attributing the arms' 16.7-point gap to verification would be
claiming credit for catching a defect it demonstrably does not detect.

This is a different blindness from last time, and a harder one. Last time the loop was blind
because a script was undeclared, which a manifest edit fixed. This time it is blind because
`tsc` and Vite cannot express "the list renders three items" — only the browser checks can, and
those belong to the grader, not the guard.

### No repair turn has ever fired

Every run in both arms, both measurements — twelve funded runs now — records
`turns: { started: 1, completed: 1 }`. The repair path added in `c17b495` has still never
executed against real infrastructure on a funded run.

The near miss is worth recording. Control run `41e1a274` failed `typecheck — exit 1`, which is
precisely the defect the template fix now makes visible: verification-on, that run should have
caught it, prompted a repair turn, and either fixed it or exhausted its three attempts. But the
typecheck failure landed in the arm where verification was off by construction, and none of the
three verification-on runs produced a type error. One coin-flip away from the observation this
run was funded to make.

### The control arm no longer ceilings, which is the one methodological gain

`terra` scored 100/100/100 with SD 0.0 and left nowhere to move. `luna` scored 50/94/100, SD 27.3.
The task does separate this model — that half of the previous write-up's advice was right. But
n=3 against SD 27.3 has a confidence interval wide enough to swallow any effect the loop could
plausibly have.

## Cost of the loop

| | off | on |
|---|---|---|
| mean turn time | 25.4s | 25.9s |
| mean tokens in / out | 10,191 / 2,368 | 11,686 / 2,475 |
| mean cost per run | $0.00244 | $0.00266 |
| repair turns fired | — | 0 |

Still within noise, still for the same reason: no verification-on run had a check fail, so the
loop cost one round of `typecheck`, `build` and `preview` and nothing else. The token spread on
the "on" arm is one run (`d8ab758a`) reading 14,660 input tokens against ~10,200 for the rest —
turn variance, not loop overhead, since that run fired no repair either.

## What this measurement licenses being said

- That the template fix is live and effective: the loop discovers and arbitrates `typecheck` on
  projects built from the current image, where before it saw nothing.
- That `expense-ledger` separates `gpt-5.6-luna`, and is therefore a usable instrument.
- Nothing whatever about whether verification improves scores. Two funded measurements, twelve
  runs, zero repair turns.

## Follow-ups

- **Stop measuring this end-to-end at n=3.** Two experiments have now failed to fire a repair
  turn by waiting for one to occur naturally; the base rate of a loop-visible defect is roughly
  1 in 6, so n=3 per arm is underpowered by construction. The next attempt should either inject
  a known type error and measure whether the loop repairs it — a test, not a benchmark — or run
  a suite large enough that a typecheck failure is likely in every arm. The former is free.
- **The loop's reach is the real open question.** The defect that dominated this measurement
  (an app that builds and serves but renders wrong) is invisible to every check the template can
  declare. Closing that means the loop running something behavioural, which is the grader's job
  today and deliberately so (ADR-0007). Whether that boundary should move is a design question,
  not a measurement one.
