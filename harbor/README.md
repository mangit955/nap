# Nap under Harbor

[Harbor](https://github.com/harbor-framework/harbor) runs agents against tasks in parallel, gives
each run a job directory, and reads a reward out of it afterwards. This directory holds two
adapters with opposite shapes:

| Package | Runs | Where the agent works | Who scores |
|---|---|---|---|
| `nap_harbor` | Public benchmarks, e.g. Terminal-Bench 2.1 | Inside the task's own machine | The benchmark's hidden tests, via Harbor's verifier |
| `napbench_harbor` | NapBench (retiring) | On the host | NapBench's own report, re-emitted |

[`docs/adr/0035`](../docs/adr/0035-a-public-benchmark-runs-the-agent-inside-the-task.md) says why
the first is shaped the way it is, and [`docs/adr/0014`](../docs/adr/0014-harbor-orchestrates-and-scores-nothing.md)
why the second is.

## Terminal-Bench

```bash
uv run --directory harbor --extra harbor harbor run \
  -d terminal-bench/terminal-bench-2-1 -i terminal-bench/regex-log -i terminal-bench/fix-git \
  -a nap_harbor.agent:NapAgent -m nvidia/nemotron-3-ultra-550b-a55b:free \
  -n 1 -o ~/.cache/nap-harbor/jobs
```

- `-m` is any OpenRouter model id. One without `:free` is refused unless `NAP_HARBOR_FLAGS`
  contains `--spend`, because it costs money.
- Harbor pulls each task's published image. Those are amd64-only, and Docker Desktop runs them
  under emulation on an arm64 Mac: slower, but the benchmark as published. `--force-build` builds
  each task from its Dockerfile instead, natively, but some no longer build: `fix-git`'s clones a
  GitHub repository that has since been deleted.
- `-i` picks tasks by namespaced name (`terminal-bench/<task>`, globs allowed);
  `harbor download terminal-bench/terminal-bench-2-1` fetches all 89 to read.
- `NAP_HARBOR_FLAGS` passes flags to the entrypoint, e.g. `--max-steps=15`, or `--review` to have
  Nap's reviewer check each claim of done (ADR-0036; the workflow's `review` input). A step is one
  model call, and a call the provider retries after a throttle or a failure is several requests, so
  a free model's quota, counted in requests, can go faster than the steps do. A reviewer's calls
  are requests too, on top of the agent's steps.
- Needs Docker, `bun install` done, and `OPENROUTER_API_KEY` in `apps/api/.env`.

For each trial, Harbor writes `<job>/<trial>/verifier/reward.txt` (1 or 0, from the task's hidden
tests) and `<trial>/result.json`, whose `agent_result.metadata` carries Nap's outcome,
`model_requests` (HTTP requests, retries included) and `model_steps` (the agent's model calls). In `<trial>/agent/`:

| File | Written by |
|---|---|
| `instruction.md` | The Python agent: the task's instruction, read by the entrypoint |
| `trajectory.jsonl` | The entrypoint: every event of the turn, one per line |
| `nap-result.json` | The entrypoint: outcome, model requests and steps, token usage, wall time, and with `--review` each review (what it proved, its steps and tokens, whether it sent the agent back, and the files its commands wrote) |
| `nap.log` | The entrypoint's stderr: the turn as it ran, one event per line |

If Harbor gives up on a trial (its timeout, or an interrupt), the Python agent closes the
channel; the entrypoint stops its turn, still writes `nap-result.json`, and is killed if it has
not exited ten seconds later.

The agent runs with Nap's command guard as it ships. `run_command` refuses `apt-get`, direct
network tools, and shell writes to any absolute path outside `/home/user/app`, which includes the
task's own path (`echo x > /app/out.txt` is refused; the same write through `/home/user/app` or a
relative path is not). The file tools have no such check. ADR-0035 records why it is unchanged.

### Scoring a task set

A score comes from a **locked task set**, never from tasks picked by hand. `task-sets/` holds the
dataset's 89 task ids and two sets drawn from them by `nap_harbor/task_sets.py` with a fixed seed:
**test** (25 tasks), which reported numbers come from and which nothing is ever tuned against, and
**dev** (10 tasks, disjoint from test), where a change is tried first. `tests/test_task_sets.py`
redraws both and fails on a hand edit; a different draw is a new set and a new baseline.

```bash
uv run --directory harbor python -m nap_harbor.task_sets dev   # Harbor's -i flags for a set
uv run --directory harbor --extra harbor harbor run -d terminal-bench/terminal-bench-2-1 \
  $(uv run --directory harbor python -m nap_harbor.task_sets dev) \
  -a nap_harbor.agent:NapAgent -m nvidia/nemotron-3-ultra-550b-a55b:free -n 2 -o <jobs> --job-name <name>
bun run packages/runtime/scripts/harbor-report.ts <jobs>/<name>   # writes report.md and report.json
```

The report (`packages/runtime/src/harbor-report.ts`) gives:

- **Pass rate** over every trial the job planned (its `lock.json`), with a harness error or a
  trial the job never finished counted as a failure, and its 95% Wilson interval. At 25 tasks
  that interval spans up to about 37 points (7 of 25 is 14% to 48%), so one run cannot tell
  apart two agents a few points apart.
- **Claimed done against the hidden tests**: a two-by-two of Nap's claim and the reward, over the
  trials Nap ran and the tests judged; a harness error, a missing result, a missing reward or an
  unfinished trial is left out and counted beside it. The claim is the turn's ending:
  `completed` means the agent stopped and handed back, which Nap shows as done. Its prose is not
  read, so a turn that completes by saying it failed still counts as a claim.
- **Cost** from Nap's own token counts priced by `@nap/shared/pricing`, a `:free` model at $0: an
  estimate, not a bill.
- **Failures by kind**: Harbor's timeout, a harness error, a trial that never finished, the step
  budget, the model unreachable, a claim of done the tests refuted, and the rest.
- **Review**, for a run with `--review` only: how many claims were reviewed and sent back, how
  each sent-back trial ended, the reviewer's model calls and cost (inside the totals, never in the
  agent's steps), and any trial where a review's commands wrote files in the task's directory. The
  task table gains a "Reviews (sent back)" column.

The first scored run, on the test set with `openai/gpt-6-luna`, is written up in
[`docs/napbench-terminal-bench-baseline.md`](../docs/napbench-terminal-bench-baseline.md).

`NAP_HARBOR_FLAGS=--scripted` runs a scripted model instead of OpenRouter: no key, no spend. It
checks the wiring end to end and nothing about the agent; its report says so.

**On GitHub.** The `Benchmark` workflow (`.github/workflows/benchmark.yml`) does the same on a
free x86 runner, where the task images run natively. It is manual only (Actions, Benchmark, Run
workflow) and takes the set, the model, `spend`, the concurrency, `scripted` and `review`. It reads the key
from the repository secret `BENCHMARK_OPENROUTER_API_KEY`, refuses a paid model without `spend`,
holds a free model to two trials at once (its quota is about 20 requests a minute), and uploads
the job directory with the report as an artifact. Harbor's output goes there rather than into the
log, to keep the log readable; both are public, as the repository is. A workflow can be dispatched only once it is on the default branch.

## NapBench

### What is here

```
harbor/
├── nap_harbor/
│   ├── channel.py   # answers the agent's commands with environment.exec; standard library only
│   ├── trial.py     # the entrypoint's command line and its result file; standard library only
│   └── agent.py     # the BaseAgent — starts the entrypoint and relays its channel
├── napbench_harbor/
│   ├── trial.py     # every decision, importing nothing but the standard library
│   └── agent.py     # the BaseAgent — a subprocess call and some bookkeeping
├── tests/           # pytest, runnable with no evaluation framework installed
└── tasks/           # generated by `bun run harbor:tasks`, never committed
```

### Running a suite

```bash
bun run harbor:tasks                       # regenerate the registry from @nap/bench/suite
uv run --directory harbor --extra harbor harbor run \
  -p tasks/reading-list \
  -a napbench_harbor.agent:NapbenchAgent
```

The trial runs **on the host**, so it needs everything `bun run napbench` needs and in the same
places: a checkout, `bun install` already done, and — for a real run — `apps/api/.env` and a Chrome
at `NAP_CHROME_PATH`.

Two environment variables change what a trial does:

| Variable | Effect |
|---|---|
| `NAPBENCH_FLAGS` | Passed to `napbench` verbatim, e.g. `--real --model=openai/gpt-5.6-luna`. **Absent means a dry run**: free, offline, and the scores mean nothing. |
| `NAP_REPO_ROOT` | Where the Nap checkout is, when it is not the parent of this directory. |

Fan-out multiplies spend: every concurrent trial of a real run is a real E2B sandbox and real model
calls, and nothing here caps that.

### What a trial leaves behind

In the job directory the harness mounts at `/logs/agent`:

| File | Written |
|---|---|
| `report.json` | **On every trial, measured or not** — status, error kind, every check, the score when there is one. A trial the benchmark itself crashed on gets an evaluator-error report rather than nothing. |
| `trajectory.json` | The run's event stream, when the run produced one. |
| `trial.log` | Everything the run printed, written by the trial entrypoint. |
| `harbor-agent.log` | The wrapper's own view of the same run — a separate file so two writers never interleave, and so a trial that died before the entrypoint opened its log still says something. |

And in `/logs/verifier`:

| File | Written |
|---|---|
| `reward.json` | Only when the run measured something. A run that errored or was cancelled produces **no reward file and a non-zero exit** — a failed trial rather than a scored one. A zero would file our bad afternoon against the model. |

## Gates

The rest of the repository is guarded by Biome, `tsc` and vitest, none of which can see Python.
This directory has its own:

```bash
bun run lint:py    # ruff check + format --check
bun run test:py    # pytest, with no evaluation framework installed
uv run --directory harbor --extra harbor --with pytest pytest    # …and with one
```

Both `bun run` scripts run in CI on every push, and lefthook runs them on any commit touching a
`*.py`. Editing the Python here therefore needs [`uv`](https://docs.astral.sh/uv/) installed;
nothing else does.

**The suite runs twice in CI, and the difference is the point.** Without Harbor it proves the
claim that everything a test drives imports nothing but the standard library — that is what
`trial.py` is for. With Harbor installed, `tests/test_agent.py` stops skipping, and `agent.py`
— the one file coupled to somebody else's classes — becomes reachable by a gate at all.

Two claims span both languages, and both are guarded from the TypeScript side, in
`apps/napbench/src/harbor-agreement.test.ts` — a drift in either is a failure neither toolchain
would see on its own:

- the `<!-- napbench-task: <id> -->` marker that the generator writes and `trial.py` reads back,
  where a drift makes every trial refuse to start;
- the report field names `context_from_report` reads the run's cost out of, where a drift is
  quieter and worse — the figures simply come back absent, which looks like a run nobody priced.

`nap_harbor` has three cross-language claims, each guarded on both sides:

- the exec channel's lines: `nap_harbor/channel-example.jsonl` is parsed by
  `packages/sandbox/src/exec-channel.test.ts` and by `tests/test_nap_channel.py`;
- the result file: `nap_harbor/result-example.json` is parsed by
  `packages/runtime/src/harbor-task-args.test.ts` and by `tests/test_nap_trial.py`;
- the job directory's file names and the entrypoint's path, which `harbor-task-args.test.ts` reads
  out of `nap_harbor/trial.py`.
