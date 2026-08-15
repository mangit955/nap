# The first funded NapBench run

What the benchmark did the first time it was pointed at real infrastructure, and what that
revealed which no amount of dry running could have.

Three suites have now been run. The first is the one worth reading about — it found a check no
model could ever have passed. The third is the one committed as
[`napbench-example-report.json`](napbench-example-report.json), because it is the first to include
an accessibility audit, and the audit found something.

**Configuration.** Four tasks, five turns, `openai/gpt-5.6-luna` via OpenRouter at medium effort,
40 steps and 120k context tokens per turn, against real E2B sandboxes with browser checks driven
from a real Chrome on the host. 2026-08-15.

---

## Run 1 — the number was wrong for a reason no model could have influenced

| Task | Status | Score | functional | browser | code |
|---|---|---|---|---|---|
| landing-page | failed | 85 | 100 | 100 | **0** |
| todo-crud | failed | 88 | 100 | 100 | **0** |
| debug-broken | failed | 88 | 100 | 100 | **0** |
| responsive-layout | failed | 88 | 100 | 100 | **0** |

Mean 88.0 over four completed runs. No agent errors, no infrastructure errors. Every functional
and browser check on every task passed on the first attempt — including the regression pair the
to-do task exists for, where the agent added a completed-items filter in a second turn without
breaking the persistence the first turn established.

And every task failed exactly one check: `lint`, `exit 1`.

**The template has no `lint` script.** Every task's code-category check ran `bun run lint` against
a project whose `package.json` declares `dev`, `build` and `preview` and nothing else. Verified
afterwards on a pristine sandbox:

```
$ cd /home/user/app && bun run lint
exit 1
error: Script not found "lint"
```

So the `code` category — 10% of the configured weight, ~12% effective once visual renormalises
away — scored zero on every task of every run, for every model, forever. It was not measuring
code quality. It was measuring whether a script existed, and the answer was always no.

### Why nothing caught it earlier

Three separate safety nets were in place and all three were blind to it:

- **The dry runs passed it.** `InMemorySandboxManager` answers an unscripted command with a
  plausible success, so `bun run lint` returned exit 0 in every free run. The fake was being a
  good stand-in and that is exactly what hid the problem.
- **The unit tests were right.** They assert what a task *declares* — that every task has a check
  scoring into `code`, that categories are overridden correctly — and every one of those claims
  was true. A declaration cannot tell you whether a command exists inside an image.
- **The report says `exit 1` and not why.** A check result carries the exit code and no output,
  so even reading the four reports afterwards did not say "script not found". That is what let a
  systematic failure look like four ordinary ones.

The guard is now `apps/napbench/src/task-commands.integration.test.ts`: it creates one sandbox and
runs every command check every task declares against a project **nobody has touched**, asserting
exit 0. A benchmark check must be able to fail on the agent's work; one that cannot pass on the
starting state is measuring the harness. It was observed failing on the old command before being
kept — the assertion prints the command's output, which is the thing the report could not.

---

## Run 2 — the same suite, with a check that can be earned

The four tasks now run `bunx tsc --noEmit` (the template carries `typescript` and a strict
`tsconfig.json`, so the binary is there and the standard is real) instead of a script that does
not exist.

| Task | Status | Score | functional | browser | code | turns | tools | tokens | cost |
|---|---|---|---|---|---|---|---|---|---|
| landing-page | **passed** | 100 | 100 | 100 | 100 | 1 | 4 | 5,357 / 1,828 | $0.0016 |
| todo-crud | failed | 88 | 100 | 100 | **0** | 2 | 10 | 36,315 / 3,518 | $0.0057 |
| debug-broken | **passed** | 100 | 100 | 100 | 100 | 1 | 4 | 3,892 / 210 | $0.0005 |
| responsive-layout | **passed** | 100 | 100 | 100 | 100 | 1 | 5 | 6,846 / 1,158 | $0.0014 |

Mean 97.0 over four completed runs, 0% agent errors, 0% infrastructure errors.

Only one report is committed, and it is now run 3's landing page. The other rows in every table
come from each suite's console summary: `napbench-results/` is gitignored, so the other eleven
reports and their screenshots stayed on the machine that ran them. One worked example is what was
asked for, and committing twelve would make the repository the results database that v1 explicitly
does not have.

**The check now discriminates**, which is the whole test of whether it belongs: three tasks earn
it and one does not. The one that does not is the two-prompt task — the most code written, the
most opportunity to be wrong — and the failure is a real one:

```
src/App.tsx(1,10): error TS1484: 'FormEvent' is a type and must be imported
using a type-only import when 'verbatimModuleSyntax' is enabled.
```

Reproduced by writing the agent's own file, taken from the run's trajectory, into a fresh sandbox.
The agent wrote `import { FormEvent, useEffect, useState } from "react"`, which is idiomatic React
everywhere except under `verbatimModuleSyntax`, which the template turns on. The application
builds and runs correctly — Vite strips types without checking them — so this is exactly the class
of defect the `code` category exists to catch and the `functional` and `browser` categories
cannot.

---

## Run 3 — the accessibility audit, against applications a model really wrote

The third check kind landed after run 2: `accessibility`, auditing one rendered page with axe and
failing on findings at or above a declared grade. Until this suite it had only ever been run
against a scripted page, and the adapter only ever against a fixture of our own making.

| Task | Status | Score | functional | browser | code | notes |
|---|---|---|---|---|---|---|
| landing-page | failed | 94 | 100 | 100 | **50** | the audit found `color-contrast`, serious, on 6 elements |
| todo-crud | failed | 74 | **75** | 100 | **0** | typecheck again, **and** deletion left a row behind |
| debug-broken | **passed** | 100 | 100 | 100 | 100 | |
| responsive-layout | **passed** | 100 | 100 | 100 | 100 | the mobile audit passed |

Mean 92.0 over four completed runs, 0% agent errors, 0% infrastructure errors.

**The audit works, and it discriminates.** It failed the landing page on a real finding — six
elements whose text does not have enough contrast against their background, which is the single
most common thing a generated page gets wrong — and passed the responsive layout's collapsed
navigation at 375px, where an unnamed menu control would have been the obvious failure. A check
that fired on both, or neither, would have told us nothing. This one separated them.

It is also worth being precise about what it cost the landing page: the audit did not fail the run
on its own. `code` was two checks, the typecheck passed and the audit failed, so the category
scored 50 and the overall came to 94 rather than 100. That is the weighting working as designed —
an accessibility finding is a quality defect, not a broken application.

**And the same task scored differently than it did in run 2.** `todo-crud` failed `deletes-a-todo`
this time — `expected 0 matching role=listitem, found 1` — having passed it in both earlier suites,
on the same model at the same effort with the same prompt. Nothing about the benchmark changed for
that check. That is generation variance, and it is the most important caveat on every number in
this document: **one suite is one sample.** Ranking two configurations on single runs would be
reading noise. Repeats per task are the obvious next piece of work, and they are the reason the
report carries a run id distinct from everything else.

---

## What else the real runs showed that the fakes could not

**The agent is better than the harness assumed.** Every functional and browser check passed on
every task in both runs, first time, on the *cheap* model at medium effort. The benchmark was
designed on the expectation that early scores would look harsh; they did not. The interesting
consequence is that these four tasks may already be too easy to separate two models — the
discriminating signal in run 2 came from one strict-TypeScript failure, not from behaviour.

**Preview reachability held, and quickly.** Re-confirmed before spending: the preview served on
the **first** probe, 3,074ms from cold, and the page rendered through the public proxy 2.4s after
navigation. Across the nine sandboxes that served a preview — eight benchmark runs and the spike —
there was not one `preview_unreachable` or `preview_not_started` gate, and the infrastructure error
rate was 0% in both suites — the risk
[issue #19](https://github.com/mangit955/nap/issues/19) was opened to retire stayed retired.

**Turns are fast and cheap; the wall clock is elsewhere.** Turn time ran 8–43 seconds, but a whole
four-task suite takes several minutes. The difference is sandbox creation, `bun run build`, the
preview wait and four browser sessions — none of which the report's `turn time` covers, and it is
named for the turns precisely so nobody reads it as the run's duration.

**A favicon 404 appears on every application.** The template declares no favicon, so Chrome's
automatic request 404s on every page load. The adapter filters it as browser noise; without that
filter, `expectNoConsoleErrors` would fail on every task equally and penalise nothing.

---

## Cost

| | |
|---|---|
| Run 1, model | $0.0116 |
| Run 2, model | $0.0092 |
| Run 3, model | $0.0117 |
| **Total model spend** | **$0.0325** |
| Sandboxes | 17 in total — 12 benchmark runs, 1 reachability spike, 2 command-guard runs (one of them the deliberate failure), 1 template probe, 1 typecheck reproduction. Seconds to a few minutes each. |

**Every money figure here is NapBench's own estimate**, summed from the reports' `estimatedCost`,
which prices the model that was *asked for* against `packages/bench/src/pricing.ts` at its published
rate. No provider invoice was read, OpenRouter's margin is not modelled, and the E2B side is not
priced at all — sandbox time is recorded as a count and a duration because that is what was
measured. The number is the right order of magnitude for a decision and is not an accounting fact.

Both runs together cost about two cents of model spend. The estimate comes from
`packages/bench/src/pricing.ts` and is labelled an estimate everywhere it appears: it prices the
model that was *asked for* at a published rate, and OpenRouter's own margin is not modelled.

---

## What would be worth doing next

- **Record a failing check's output, not just its exit code.** The single change that would have
  turned run 1's bug from a day into a minute. It needs a field on `CheckResult` and a decision
  about truncation, so it is a ticket rather than a footnote.
- **Harder tasks.** Three of four at 100 is not a benchmark that can rank anything. The six tasks
  cut from v1 — kanban, form validation, dashboard filtering, localStorage persistence,
  modify-an-existing-app, a longer multi-step application — are the obvious next spend.
- **Repeats per task.** Run 3 scored a check differently from run 2 with nothing changed but the
  day, so a single suite cannot separate two configurations. This is now the most valuable next
  thing, ahead of more tasks.
- **A second model.** Everything here characterises one model on one day. The comparison tooling
  exists and has never been pointed at two real runs of different models.
