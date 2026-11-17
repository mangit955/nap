# Terminal-Bench 2.1 baseline: Nap's agent as it ships

The first scored run of Nap's own agent on a public benchmark, run so a later change can be
measured against it on the same model and the same tasks.

**Configuration.** The locked **test** set (`harbor/task-sets/terminal-bench-test.txt`): 25
tasks of `terminal-bench/terminal-bench-2-1@sha256:7d7bdc1c…`, drawn with seed 20261117 and
committed before any scored run. `openai/gpt-6-luna` via OpenRouter, medium effort, 8,192 output
tokens a call, 20 steps a task (the entrypoint's default). Harbor 0.26.0, four trials at once,
timeouts as published (multiplier 1.0), each task's own published image on a GitHub-hosted
x86 runner. The agent ran from commit `0da374b` (the entrypoint, prompts, tools and command guard
are unchanged since). The `Benchmark` workflow ran it in run
[`44003376019`](https://github.com/mangit955/nap/actions/runs/44003376019) on 2026-11-17, in 34
minutes. The figures below come from `packages/runtime/scripts/harbor-report.ts` at this
change's head, read over that run's artifact. `napbench-terminal-bench-baseline.report.json`
beside this file holds every figure.

---

## The headline

| | |
|---|---|
| Passed | **7 of 25 (28.0%)** |
| 95% interval (Wilson) | 14.3% to 47.6% |
| Harness errors, unfinished trials | 0, 0 |
| Cost, by Nap's accounting | $0.2326, $0.0093 a task |
| Steps, model requests | 429, 429 |
| Tokens | 4.61M input (4.26M from cache), 0.29M output |

**Read the interval, not the point.** On 25 tasks it spans 33 points. A later run that scores
32% or 24% has not shown a difference: one or two tasks out of 25 is within what a rerun of the
same agent can move. A comparison has to be on these same 25 tasks and this model, and a small
effect needs repeated runs before it means anything.

## Nap's claim of done, against the hidden tests

| | Tests passed | Tests failed |
|---|---|---|
| Claimed done | 5 | 8 |
| Did not claim | 2 | 10 |

Agreement is 60% (15 of 25). The useful reading is the top row: **when Nap said it was done, the
hidden tests agreed 5 times in 13 (38%).** The eight false claims are the gap a reviewer is
meant to close. Each is a trial that a check after the turn could have caught, and that Nap
instead reported as done.

"Claimed done" means the turn ended `turn.completed`: the agent stopped calling tools and handed
back, which is what Nap shows a person as done (CONTEXT.md, **Claimed done**). Nothing reads the
agent's final message, so a turn that completes by saying it could not finish still counts as a
claim. The false-claim count is therefore an upper bound on confident false claims.

The two passes without a claim (`git-multibranch`, `schemelike-metacircular-eval`) are runs that
spent all 20 steps, having already left the task in a passing state.

## Why the failures failed

| Kind | Trials |
|---|---|
| Nap's step budget ran out | 10 |
| Nap claimed done; the hidden tests failed | 8 |

There were no harness errors, no Harbor timeouts and no throttled requests: 429 steps took 429
requests, so the provider never retried one.

**The step budget is the largest single cause.** Ten of the eighteen failures stopped at 20 steps,
mid-task. Their published expert estimates run from 20 minutes to three hours, and Terminal-Bench
gives the agent 12.5 to 60 minutes of wall time on them. The budget ended every one in under 16
minutes, and eight of the ten in under 6.

**The command guard refused 33 of 264 commands (12.5%), in 14 of the 25 tasks.** It refuses
`apt-get`, direct network tools and shell writes outside `/home/user/app`, and on these tasks
that also caught read-only probes such as `dpkg -l`, `R --version` and `find /usr …`. Three of
those fourteen tasks passed anyway.

## What this measures, and what it does not

**It measures the agent as it ships.** The command guard, the 20-step budget and the prompts
are Nap's product defaults, not tuned for this benchmark. Each depresses the score: the guard
refuses package installs and probes that Terminal-Bench tasks expect, the budget ends long
tasks partway through, and there is no compaction, so a long turn could not have continued past
the window even with more steps. Changing any of them is a product decision that needs its own
before-and-after on these tasks, not a quiet edit before a headline.

**It is not a leaderboard entry.** Terminal-Bench's leaderboard runs the full 89 tasks, usually
several times. This is 25 tasks, once, on a cheap model, chosen to leave room to see an
improvement.

**The verify step is not in this composition.** In the product, a turn that changes files is
followed by Nap's own checks (CONTEXT.md, **Verification**). The Terminal-Bench entrypoint
runs the agent loop only (ADR-0035), so the claim measured here is the model's, with no system
finding behind it.

## Cost: measured, projected, then spent

| | Tasks | Nap's estimate | Per task |
|---|---|---|---|
| Measurement, 3 dev tasks on a Mac (emulated) | 3 | $0.0162 | $0.0054 |
| Projected for the test set from that | 25 | $0.14 | |
| Spent on the test set | 25 | $0.2326 | $0.0093 |

The three-task estimate was checked against the bill: OpenRouter's account usage moved by
$0.01618 over that run, and Nap's figure was $0.0162. Cache writes, priced at 1.25 times input,
are what make it match. Without them it would have been $0.0149.

**The projection was 40% low.** The three measured tasks happened to cost less than the test
set's average ($0.0054 a task against $0.0093). The test set's most expensive task (`path-tracing-reverse`, $0.0225) cost seven times its
cheapest (`pypi-server`, $0.0025). A projection from three tasks should carry that spread. At
the test set's own mean, the dev set costs about $0.09 and the test set about $0.23 a run. Both
are far below the $1 a run that needs asking first.

## SWE-bench Pro

**Deferred, for disk rather than money** ([#269](https://github.com/mangit955/nap/issues/269)).
Harbor runs `cais/swebenchpro`: 731 tasks, each working in `/app`, so the same adapter applies.
Three tasks drawn with the same seed ran on `gpt-6-luna` on a Mac, emulated:

| Task | Passed | Claimed done | Steps | Cost |
|---|---|---|---|---|
| ansible-489156 | yes | yes | 16 | $0.0096 |
| element-web-f3534b | yes | no (step budget) | 20 | $0.0130 |
| vuls-0ec945 | no reward | no (step budget) | 20 | $0.0207 |

The total was $0.0433, $0.0144 a task. That projects 50 test tasks at about $0.72 and 5 dev
tasks at about $0.07, both within budget. `vuls`'s verifier ran past its 50-minute limit under
emulation. What keeps SWE-bench Pro out of this baseline is that every task brings its own
pre-built image: 0.5 to 4.7 GB compressed, in a sample of five. Fifty of them do not fit a free
runner's disk unless images are pruned between trials, and nothing here does that yet.

The OpenRouter account moved $0.2759 across the Terminal-Bench test run and these three tasks,
against Nap's estimates of $0.2326 and $0.0433, which also sum to $0.2759.

## Reproducing it

```bash
# On GitHub: Actions → Benchmark → Run workflow, set=test, model=openai/gpt-6-luna, spend=true,
# concurrency=4. Needs the BENCHMARK_OPENROUTER_API_KEY secret.
# Locally (slower: the task images are amd64 and run emulated on an arm64 Mac):
NAP_HARBOR_FLAGS=--spend uv run --directory harbor --extra harbor harbor run \
  -d terminal-bench/terminal-bench-2-1 $(uv run --directory harbor python -m nap_harbor.task_sets test) \
  -a nap_harbor.agent:NapAgent -m openai/gpt-6-luna -n 4 -o <jobs> --job-name <name>
bun run packages/runtime/scripts/harbor-report.ts <jobs>/<name>
```

## Every task

| Task | Passed | Claimed done | Failure | Steps | Cost | Agent time |
|---|---|---|---|---|---|---|
| adaptive-rejection-sampler | no | no | step_budget | 20 | $0.0116 | 206s |
| break-filter-js-from-html | no | no | step_budget | 20 | $0.0123 | 291s |
| configure-git-webserver | no | yes | claimed_done_tests_failed | 13 | $0.0044 | 86s |
| constraints-scheduling | yes | yes |  | 14 | $0.0054 | 97s |
| dna-assembly | no | no | step_budget | 20 | $0.0181 | 326s |
| feal-differential-cryptanalysis | yes | yes |  | 16 | $0.0133 | 273s |
| filter-js-from-html | no | yes | claimed_done_tests_failed | 14 | $0.0097 | 185s |
| fix-code-vulnerability | yes | yes |  | 12 | $0.0067 | 53s |
| gcode-to-text | no | yes | claimed_done_tests_failed | 17 | $0.0077 | 124s |
| git-multibranch | yes | no |  | 20 | $0.0065 | 112s |
| largest-eigenval | no | no | step_budget | 20 | $0.0071 | 150s |
| mcmc-sampling-stan | no | no | step_budget | 20 | $0.0102 | 932s |
| merge-diff-arc-agi-task | no | no | step_budget | 20 | $0.0073 | 152s |
| model-extraction-relu-logits | no | yes | claimed_done_tests_failed | 13 | $0.0083 | 170s |
| multi-source-data-merger | yes | yes |  | 14 | $0.0031 | 55s |
| overfull-hbox | no | no | step_budget | 20 | $0.0051 | 102s |
| path-tracing-reverse | no | no | step_budget | 20 | $0.0225 | 133s |
| protein-assembly | no | no | step_budget | 20 | $0.0080 | 126s |
| pypi-server | yes | yes |  | 14 | $0.0025 | 58s |
| regex-chess | no | yes | claimed_done_tests_failed | 13 | $0.0109 | 210s |
| sanitize-git-repo | no | yes | claimed_done_tests_failed | 17 | $0.0104 | 109s |
| schemelike-metacircular-eval | yes | no |  | 20 | $0.0123 | 204s |
| torch-pipeline-parallelism | no | yes | claimed_done_tests_failed | 12 | $0.0075 | 145s |
| train-fasttext | no | no | step_budget | 20 | $0.0056 | 811s |
| video-processing | no | yes | claimed_done_tests_failed | 20 | $0.0161 | 209s |
