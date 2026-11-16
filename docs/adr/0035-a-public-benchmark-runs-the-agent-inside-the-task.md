# ADR-0035 — A public benchmark runs the agent inside the task's machine

**Status:** Accepted — 2026-11-16. Leaves [ADR-0014](0014-harbor-orchestrates-and-scores-nothing.md)
standing for NapBench and decides the opposite for public benchmarks, for the reasons below.

## Context

ADR-0014 adopted Harbor for NapBench and kept everything out of its container: the trial ran on the
host, because NapBench needs host Chrome, E2B and the host `.env`, and the verifier re-emitted a
report NapBench had already written. Harbor bought fan-out, a job layout and a registry, and the
container was nearly empty by design.

Measuring Nap's agent on a public benchmark such as Terminal-Bench 2.1 changes both premises.

- **The task's machine is the workspace.** Each task ships a Dockerfile that builds the machine the
  work happens in: the files to fix, the tools installed, the working directory. The agent has to
  act inside it. Nothing about the task needs E2B, Chrome or a preview.
- **Harbor's verifier is the judge.** Each task carries hidden tests that Harbor runs in the same
  machine after the agent stops, and they write the reward. A score Nap computed for itself would
  not be the benchmark's score.

So the question ADR-0014 answered ("what may cross into Harbor?") has a different answer: the agent
crosses in, as a guest in a machine somebody else built, and the scoring stays where the benchmark
put it. Nothing from 0014 is reversed for NapBench, which keeps its adapter until NapBench is
retired.

## Decision

### The agent loop stays TypeScript and reaches in through `environment.exec`

`harbor/nap_harbor/agent.py` is a `BaseAgent` that starts `packages/runtime/scripts/harbor-task.ts`
with `bun` and serves it a channel: the child writes one JSON line per command on stdout, the parent
runs each through `environment.exec` and writes the answer on the child's stdin
(`@nap/sandbox/exec-channel`, `harbor/nap_harbor/channel.py`).

The alternative was to hand the child a Docker container id and let it run `docker exec` itself.
That needs Harbor's private naming for Compose projects, and it works for one of Harbor's many
environments. `environment.exec` is the one call every environment has (Docker, Daytona, Modal,
E2B), so the same agent runs on any of them. The Python side stays a relay: it decides nothing about
the task, as in ADR-0014.

### A small exec-only sandbox, not a derivative of the local Docker one

`ChannelSandboxManager` implements `SandboxManager` with nothing but that channel: files cross as
base64 in command lines and output, listings are one shell command each, and a command's deadline
is enforced inside the machine with `timeout`, so a hung foreground command is stopped there rather
than left running under the hidden tests. It adopts the one machine it is given and never creates
or removes one, because Harbor owns the machine's lifetime.

`apps/api/scripts/computer-local-sandbox.ts` was the other candidate. Almost all of it is the
desktop, the preview port bridge and container lifecycle, none of which a task machine has, and it
reaches containers by name over the Docker CLI, the coupling the previous section avoids.

### The smallest composition that is still Nap's agent

`runTaskTurn` (`packages/runtime/src/task-turn.ts`) is the context engine, the agent service and the
sandbox, and nothing else: no preview, verification, commit, snapshot or thumbnail, which are all
part of a Nap turn and all wrong for a benchmark task. It counts model calls and tokens at the
provider, because a failed turn's event carries no usage, and HTTP requests at the client
(`@nap/agent/counted-client`), because the provider retries a throttled request inside one call and
a free model's quota counts every request.

Two adjustments make Nap's agent usable in a machine it did not build, and both are limited to
this path:

- **The project path is a link.** The agent's tools, its command guard and its prompt all name
  `/home/user/app`. The composition links that path to the task's working directory, which is
  usually `/app`, instead of teaching every tool a second root.
- **The prompt is the task's.** `ContextRequest.workspace` gains `task`, with a short system prompt.
  The starter prompt describes a React template that is not there, and the repository prompt forbids
  merging and changing branches, which a task like `fix-git` asks for.

What is **not** adjusted is the command guard. It refuses `apt-get`, direct network tools and shell
writes outside the project, as it does in production. It compares paths as text, so a shell write to
the task's own `/app/…` is refused even though the link makes it the project; the agent recovers by
writing through `/home/user/app` or a relative path, at the cost of a step. The baseline measures the
agent Nap ships, and whether a benchmark run should relax the guard is a separate measured change.

### Spending is refused unless asked for

The entrypoint refuses a model that is not free unless `--spend` is passed, as the rest of the
repository puts real spend behind a flag.

## Consequences

- Running Terminal-Bench needs Harbor, Docker, `bun` and a checkout. The task machine needs `bash`,
  `base64` and `timeout`, which every Debian and Ubuntu task image has, and `mktemp` to keep a
  command's stderr apart (without it, stderr is discarded).
- Terminal-Bench's published images are amd64-only. On an arm64 machine they run under Docker's
  emulation, or `--force-build` builds each task from its Dockerfile natively. A rebuilt image may
  differ from the published one when a Dockerfile installs something that has moved, and some no
  longer build: `fix-git`'s clones a GitHub repository that has been deleted. The published image
  is the benchmark; a rebuild is a convenience.
- Output reaches the agent when a command ends, not as it is printed: the channel has no streaming,
  so the live `command.output` events are coarser. Harbor's Docker environment also folds stderr
  into stdout, so the adapter frames every command's output with markers of its own and collects
  stderr apart; a command's stdout and stderr then arrive separated, not interleaved.
- A turn that outgrows its context budget fails instead of compacting, because this composition
  does not carry the runtime's compaction. Measured tasks have not come close, and it is the first
  thing to add if one does.
- The cross-language agreements (the channel's lines, the result file, the job directory's file
  names) are each guarded on both sides: `channel-example.jsonl` and `result-example.json` are read
  by the TypeScript and the Python tests, and `harbor-task-args.test.ts` reads `trial.py`.
- `napbench_harbor` keeps working, on the same Harbor version, until NapBench is retired.
