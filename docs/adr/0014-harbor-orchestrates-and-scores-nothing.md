# ADR-0014 — Harbor orchestrates, and the container is nearly empty

**Status:** Accepted — 2026-08-25
**Depends on:** [ADR-0001](0001-napbench-splits-into-a-pure-package-and-an-app.md), which puts the
evaluator in a pure package and the real infrastructure in an app. This ADR decides what an
*external* harness is allowed to be, given that split — and the answer is: the outer shell of the
shell.

## Context

NapBench already runs the real product end to end: `apps/napbench/scripts/napbench.ts` composes a
real E2B sandbox, a real model over OpenRouter, a real Chrome through Playwright and a real vision
judge, and writes a report and a trajectory per run. What it does not have is a way to run many of
those at once, a per-run directory layout anybody else's tooling understands, or a registry a
stranger could point a runner at.

[Harbor](https://github.com/harbor-framework/harbor) is an evaluation framework that has all three.
Its unit of work is a **trial**: it builds an environment, runs a `BaseAgent` against an
instruction, then runs a **verifier** inside that environment, which writes a **reward** — a flat
`name → number` file — into the trial's job directory. Adopting it buys fan-out, a job layout and a
registry.

The question this ADR answers is what crosses the line into it. The obvious way to adopt a harness
is to reimplement the task inside it: put the checks in the container, let the verifier run them,
let the reward be what it computes. That would have moved the benchmark's arithmetic into a
directory that none of this repository's gates can see — `test/architecture.ts` does not read
Python, Biome does not lint it, `tsc` cannot check it, and vitest collects nothing from it.

There is also a constraint the container has to answer to. The thing under measurement reaches
*outward*: E2B sandboxes over the network, a Chrome binary at `NAP_CHROME_PATH`, credentials in
`apps/api/.env`, an OpenRouter account. Running the trial inside a container would mean rebuilding
all of that inside the image, in exchange for isolating a process whose entire job is to talk to
someone else's cloud.

## Decision

### The agent runs on the host and shells out to a trial entrypoint

`napbench_harbor.NapbenchAgent` is a `BaseAgent` that reads the task id out of the instruction and
runs `bun run napbench:trial run --task=<id> --job-dir=<its logs dir>` as a subprocess, on the host.
Host Chrome, the host `.env` and host E2B egress therefore keep working exactly as they do under
`bun run napbench`, because it *is* `bun run napbench` — the trial entrypoint shells out to the same
composition root rather than building a second one.

`--real` is not passed unless `NAPBENCH_FLAGS` asks for it, so a trial costs nothing by default, for
the same reason a benchmark run does.

### The container is built, and is near-vestigial

The generated environment is `oven/bun:1.3.13-alpine` with a working directory and nothing else.
The agent never enters it. Its only job is to be somewhere the harness can mount a job directory and
run a verifier.

**This is honest about what Harbor buys: fan-out, a job layout and a registry — not isolation.** An
image that installed the project would be pretending to a property this arrangement does not have.
A reader who assumes a container means isolation would be wrong, so the Dockerfile says so in a
comment and this ADR says so here.

### The verifier re-emits a report this repository already wrote

`tests/test.sh` runs `verify` from a single-file bundle of the same trial entrypoint. It reads
`report.json` out of the job directory, calls `rewardFor` — the function in
`packages/bench/src/reward.ts` that the whole reward rule lives in — and writes `reward.json`, or
does not.

**No check, gate, score or attribution logic moves into Harbor.** The verifier computes nothing; it
projects. Bundling rather than reimplementing is what makes that structural instead of a promise:
there is one copy of the rule, in a package covered by every gate, and the container gets a
compiled copy of it.

### A trial that measured nothing writes no reward, and still writes a report

When `rewardFor` returns nothing — an errored run, a cancelled one — the verifier writes no file and
exits non-zero. The trial failed; it did not score zero. See the reward rule in `docs/NAPBENCH.md`
for why zero is a lie.

`report.json` is written **on every trial, measured or not**, including when the benchmark itself
crashed before producing one: the trial entrypoint writes an evaluator-error report in that case, so
a job directory never holds nothing. The reward is a lossy projection of a lossless artefact.

### The Python is generated against, gated, and small

`harbor/` holds a package of about a hundred lines. Everything a test drives is in `trial.py`, which
imports only the standard library, so its suite runs on a checkout with no evaluation framework
installed; `agent.py` is the part that imports Harbor and is almost nothing — and is covered by a second
pytest run with the framework installed, since a file coupled to somebody else's classes that no
gate ever imports is exactly the shape of the mistake this repository has already made once.

The registry under `harbor/tasks/` is **generated** from `@nap/bench/suite` by `bun run harbor:tasks`
and is not committed, because a hand-maintained copy would be a second answer to "what does the
benchmark measure".

The gate story is stated rather than assumed, because shipping outside a gate has cost this
repository before (`CLAUDE.md`, "Definition of done"): `bun run lint:py` and `bun run test:py` run
ruff and pytest, lefthook runs both on any commit touching a `*.py`, and CI runs them on every push
in a job of their own. The two cross-language claims — the task-id marker the generator writes and
the agent reads, and the report field names the agent reads a run's cost out of — are guarded from
the TypeScript side by `apps/napbench/src/harbor-agreement.test.ts`, which reads the Python as text,
because those are the failures neither toolchain would otherwise see.

## Consequences

- A stranger with Harbor and this checkout can run a suite in parallel. A stranger with Harbor and
  no checkout can run nothing, which is the honest consequence of the agent being host-side.
- Concurrency is now expressible, and every unit of it is a real E2B sandbox and a real model call.
  Fan-out multiplies spend; nothing here caps it.
- The container path is exercised: the generated `environment/Dockerfile` builds, and the generated
  `tests/test.sh` running inside it writes `reward.json` for a scored run and — for an errored one —
  writes nothing and exits 1, which is the whole claim. What remains unexercised is Harbor itself
  driving a trial end to end; the agent has only been run as a subprocess by hand.
- Harbor is a dependency of nothing that ships. It sits outside the workspace, outside
  `test/architecture.ts`'s dependency table, and can be deleted without touching a line of the
  benchmark.
