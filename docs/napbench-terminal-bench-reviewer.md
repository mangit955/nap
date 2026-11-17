# Terminal-Bench 2.1 with Nap's reviewer

What a reviewer that checks the work before Nap says it is done (ADR-0036) changes on the same
locked tasks and the same model as the [baseline](napbench-terminal-bench-baseline.md).

**Configuration.** The locked **test** set (`harbor/task-sets/terminal-bench-test.txt`, 25 tasks of
`terminal-bench/terminal-bench-2-1@sha256:7d7bdc1c…`). `openai/gpt-6-luna` via OpenRouter, medium
effort, 8,192 output tokens a call, 20 agent steps a task. Harbor 0.26.0, four trials at once, each
task's published image on a GitHub-hosted x86 runner, through the `Benchmark` workflow. Five runs:

| Run | Reviewer | Agent code | GitHub run |
|---|---|---|---|
| Baseline 1 (Day 4) | off | `0da374b` | [`44003376019`](https://github.com/mangit955/nap/actions/runs/44003376019) |
| Baseline 2 | off | `a7bdb43` | [`44020421571`](https://github.com/mangit955/nap/actions/runs/44020421571) |
| Reviewer 1 | on | `a7bdb43` | [`44023121826`](https://github.com/mangit955/nap/actions/runs/44023121826) |
| Reviewer 2 | on | `a7bdb43` | [`44026867069`](https://github.com/mangit955/nap/actions/runs/44026867069) |
| Reviewer 3 | on | `a7bdb43` | [`44035523345`](https://github.com/mangit955/nap/actions/runs/44035523345) |

Baseline 2 is the same code as the reviewer runs with the reviewer off: it measures how far the
score moves by chance alone, and checks that this change left the agent without a reviewer as it
was. Every figure below comes from `packages/runtime/src/harbor-report.ts` read over each run's
artifact; `napbench-terminal-bench-reviewer.report.json` beside this file holds all five reports.
Intervals are 95% Wilson for a rate and Newcombe's hybrid score for a difference of two rates.

---

## The headline

| | Baselines (2 runs, 50 trials) | With reviewer (3 runs, 75 trials) | Difference |
|---|---|---|---|
| Passed | 12 (24.0%, 14.3–37.4%) | 22 (29.3%, 20.2–40.4%) | +5.3 points (−10.9 to +20.1) |
| False claims of done | 15 (30.0%, 19.1–43.8%) | 5 (6.7%, 2.9–14.7%) | −23.3 points (−37.6 to −9.8) |
| Claimed done, and the tests agreed | 9 of 24 (37.5%) | 14 of 19 (73.7%) | |
| Agent steps a run | 429, 426 | 455, 435, 461 | capped at 20 a task in both |
| Reviewer model calls a run | — | 41, 62, 53 | not in the agent's steps |
| Cost a run, by Nap's accounting | $0.2326, $0.2729 | $0.2888, $0.2938, $0.3076 | reviews $0.023–$0.037 of each |

**The pass rate did not measurably move.** Per run it was 7 and 5 without the reviewer, 6, 10 and 6
with it. The baseline alone moved two tasks between two runs of the same agent, which is the scale
of the noise: a gain of one or two tasks a run is inside it, and the interval on the pooled
difference runs from about eleven points worse to twenty better.

**False claims of done fell, and that holds up.** Over the two baselines Nap said it was done 24
times and the hidden tests disagreed 15 times. Over the three reviewer runs it said so 19 times and
the tests disagreed 5 times. The difference per trial excludes zero by a margin, and when Nap now
says "done", the tests agree about three times in four instead of about one in three.

## How the reviewer got there

"Claimed done" is the turn ending `turn.completed` (CONTEXT.md, **Claimed done**), now after any
review. Counting the agent's first claim in each trial, before any review:

| | Reviewer 1 | Reviewer 2 | Reviewer 3 | Total |
|---|---|---|---|---|
| First claims of done | 8 | 13 | 8 | 29 |
| Reviewed | 8 | 11 | 8 | 27 |
| Sent back on a proved problem | 2 | 5 | 3 | 10 |
| …then passed | 0 | 2 | 0 | 2 |
| …then ran out of steps fixing it | 2 | 2 | 3 | 7 |
| …then a harness error | 0 | 1 | 0 | 1 |
| Not sent back, and the tests failed | 2 | 2 | 1 | 5 |

Two claims (`git-multibranch` and `largest-eigenval` in reviewer 2) were not reviewed because the
agent claimed done on its last step, with nothing left to fix with; a review runs only when a fix
can follow. Both passed.

**Most of the drop is the reviewer turning a false "done" into an honest "not done".** Seven of the
ten trials it sent back then spent their remaining steps and stopped on the step budget, so Nap no
longer said they were finished. Only two sent-back trials passed, and neither can be credited to the
review: `fix-code-vulnerability` also passed in baseline 1 and reviewer 3 without one, and
`sanitize-git-repo` passed in reviewer 1 without being sent back. Both of those ended by using their
last step rather than by claiming done again. Whether either was already passing when the reviewer
sent it back is not known: the hidden tests run once, at the end.

**It missed the same two tasks every time.** `configure-git-webserver` and
`torch-pipeline-parallelism` were false claims in four or five of the five runs. On both, the
reviewer reported that the tool it needed to check the work (`git`, `python`) was not installed in
the task's machine; Terminal-Bench installs some test dependencies only in its verifier step. It
reported that as a note, which blocks nothing. In reviewer 3 `torch-pipeline-parallelism` ran out
of steps before claiming, so it was not reviewed.

**It never sent back work on a problem it had not proved.** Every send-back quoted the output of a
program it ran against the work, such as a Python snippet running the agent's sanitizer on an SVG
payload that still carried an `onbegin` handler. One problem in reviewer 1 (`sanitize-git-repo`,
"credentials remain in git history") quoted text that did not match its command's output, was kept
as a note, and the task passed; the same finding, proved in reviewers 2 and 3, sent the task back
both times.

**A caveat on the false-claim figure.** The reviewer runs' first turns claimed done less often than
the baselines' (29 of 75 against 24 of 50; a difference of −9.3 points, −26.3 to +8.1), and
`gcode-to-text` and `video-processing`, false claims in both baselines, ran out of steps in all three
reviewer runs without a review. The first turn is the same code with the same settings in both
arms: the first request of each of the 25 tasks has the same size in baseline 2 and all three
reviewer runs, and the trajectories show
those turns ending on the step budget with no review involved. The difference is the model's, and
the reviewer runs ran later in the day than the baselines. It inflates the per-trial drop. Read per
claim instead: of the agent's first claims, 15 of 24 ended false without the reviewer and 5 of 29
with it (−45.3 points, −64.2 to −19.0).

## Steps, cost, and what a gain could have owed to effort

**The agent never had more steps than the baseline.** A task's 20 agent steps are shared by every
round of it: a fix round gets only what the first turn left, so a task sent back after 14 steps has
6 to fix it with. That is why seven of ten send-backs ended on the step budget, and why the reviewer
runs used 435 to 461 agent steps against the baselines' 426 to 429: the extra steps are the ones a
sent-back task would otherwise have left unused, never a step past 20.

**The reviewer's own calls are separate and counted.** It took 41 to 62 model calls a run, about two
a task and five to seven a review on average, capped at 10 a review. They are not agent steps and cannot
change a file the hidden tests read: the task's directory is copied before each review and every
file a review's commands wrote is put back from the copy (`task-review-guard.ts`). Reviews wrote
files in seven trials across the three runs, and all were put back; no review's writes went
unread (each report's `review.unknownWrites` is empty). Six were caches
(`__pycache__`, `.pytest_cache`); in `multi-source-data-merger` the reviewer ran the agent's program,
which wrote the task's own output files (`merged_users.parquet`, `conflicts.json`), exactly the
case the copy exists for.

**Reviews cost 9% to 15% more a run**: $0.023 to $0.037 on top of $0.26 to $0.28 for the agent.

## What this measures, and what it does not

**It measures the reviewer users get.** The same `NapReviewer`, prompt (`@nap/context/review-prompt`)
and blocking rule run in an imported GitHub project's job before its pull request. What differs is
the budget: in the product a repair turn has a turn's full budget, so a sent-back job there has
more room to fix the problem than a benchmark task with its last few steps.

**The prompt was not tuned on these tasks.** The reviewer prompt was written once against the
request in general and tried on the dev set with a free model; nothing in it changed after a
test-set run.

**It is three runs and two on a cheap model.** Five runs of 25 tasks is enough to see a 23-point
drop in false claims, not a five-point change in pass rate. Showing a pass-rate effect of that size
would take several times more runs, or more steps per task to leave sent-back work room to be fixed,
which is a separate experiment against a raised step limit.

## Cost of this measurement

| | OpenRouter usage | Nap's estimate |
|---|---|---|
| Baseline 2 | $0.2729 | $0.2729 |
| Reviewer 1 | $0.2888 | $0.2888 |
| Reviewer 2 | $0.2938 | $0.2938 |
| Reviewer 3 | $0.3076 | $0.3076 |
| Total | $1.1630 | $1.1631 |

Two dev-set runs with the reviewer on a free model (`nvidia/nemotron-3-ultra-550b-a55b:free`) cost
nothing; they checked the wiring on real task images, including putting back what a review wrote.

## Reproducing it

```bash
# On GitHub: Actions → Benchmark → Run workflow, set=test, model=openai/gpt-6-luna, spend=true,
# concurrency=4, review=true (or false for a baseline).
# Locally:
NAP_HARBOR_FLAGS="--spend --review" uv run --directory harbor --extra harbor harbor run \
  -d terminal-bench/terminal-bench-2-1 $(uv run --directory harbor python -m nap_harbor.task_sets test) \
  -a nap_harbor.agent:NapAgent -m openai/gpt-6-luna -n 4 -o <jobs> --job-name <name>
bun run packages/runtime/scripts/harbor-report.ts <jobs>/<name>
```

## Every task, every run

"Steps" is the step budget running out; "pass (steps)" passed the hidden tests without claiming
done; "sent back →" is a review that proved a problem, then how the trial ended.

| Task | Baseline 1 | Baseline 2 | Reviewer 1 | Reviewer 2 | Reviewer 3 |
|---|---|---|---|---|---|
| adaptive-rejection-sampler | steps | steps | steps | steps | steps |
| break-filter-js-from-html | steps | steps | steps | steps | sent back → steps |
| configure-git-webserver | **false claim** | **false claim** | **false claim** | **false claim** | **false claim** |
| constraints-scheduling | pass | pass | pass | pass | pass |
| dna-assembly | steps | steps | steps | steps | steps |
| feal-differential-cryptanalysis | pass | pass | steps | pass | pass (steps) |
| filter-js-from-html | **false claim** | **false claim** | sent back → steps | sent back → steps | sent back → steps |
| fix-code-vulnerability | pass | steps | steps | sent back → pass (steps) | pass |
| gcode-to-text | **false claim** | **false claim** | steps | steps | steps |
| git-multibranch | pass (steps) | pass (steps) | steps | pass | steps |
| largest-eigenval | steps | steps | pass (steps) | pass | steps |
| mcmc-sampling-stan | steps | steps | steps | steps | steps |
| merge-diff-arc-agi-task | steps | steps | steps | pass (steps) | steps |
| model-extraction-relu-logits | **false claim** | **false claim** | sent back → steps | sent back → harness | pass (steps) |
| multi-source-data-merger | pass | pass | pass | pass | pass |
| overfull-hbox | steps | steps | steps | steps | steps |
| path-tracing-reverse | steps | steps | steps | steps | steps |
| protein-assembly | steps | steps | steps | steps | steps |
| pypi-server | pass | pass | pass | pass | pass |
| regex-chess | **false claim** | steps | steps | sent back → steps | steps |
| sanitize-git-repo | **false claim** | **false claim** | pass | sent back → pass (steps) | sent back → steps |
| schemelike-metacircular-eval | pass (steps) | steps | pass (steps) | pass (steps) | steps |
| torch-pipeline-parallelism | **false claim** | **false claim** | **false claim** | **false claim** | steps |
| train-fasttext | steps | steps | steps | steps | steps |
| video-processing | **false claim** | **false claim** | steps | steps | steps |

The harness error is Harbor's verifier running past its 900-second limit on
`model-extraction-relu-logits`, after the agent's turn had ended.
