# Commands

Every script this repository runs, with what it needs and what it costs. `AGENTS.md` lists the
everyday ones; this is the rest. **Always `bun run test`, never `bun test`** — `test` is a Bun
built-in that runs Bun's own runner over Vitest files and reports nonsense.

Load testing, the Kubernetes clusters and NapBench's product judge are **frozen**: the code and
reports stay (`docs/scaling-*.md`, `infra/k8s/`, `packages/loadgen`, `docs/napbench-*.md`) and the
commands below still work, but nothing is being built on them.

```bash
bun run test              # unit + type + web + db + computer suites — deterministic and free; db needs Docker
bun run test:fast         # unit + type + web — the Docker-free inner loop
bun run check:changed     # Biome, typecheck of the changed packages and their dependents, every node test
                          # in the changed packages plus test/, the tests elsewhere that import or name a
                          # changed file, and the Python gates if Python changed — against the merge base
                          # with origin/main, uncommitted and untracked files included; free. <ref> picks
                          # another base, --staged is the pre-commit hook. Component tests (.test.tsx) run
                          # by import only; tests that read another package's files without naming them
                          # are listed in scripts/check-changed.ts. A changed setup file runs its project;
                          # biome.json runs Biome over the repo. db tests run only when Docker is up; a
                          # computer suite only when it, its namesake, or a file it reads changed. CI
                          # still runs everything
bun run test:integration  # needs something external; run at milestone boundaries only
                          # most of it is real E2B + real model calls and costs money — but not
                          # all: the browser suites need only a Chrome at NAP_CHROME_PATH and
                          # skip without one. Each file's doc comment says what it requires.
bun scripts/setup-worktree.ts     # sets up a git worktree: bun install, then symlinks the main
                          # checkout's env files in; writes .t3/setup-{running,done,failed}. T3 Code
                          # runs it on worktree creation (t3.json). Free; safe to rerun anywhere
bun run harness "<prompt>"        # one turn, printing the event stream — fakes, free, no network
bun run harness --plan "<prompt>" # the same turn in plan mode, ending on a proposed plan — fakes, free
                          # add --approve to approve it and run the turn that builds it (ADR-0025)
bun run harness --steer="<message>" "<prompt>"  # sends a message mid-turn; it is read at the next
                          # step boundary (ADR-0028) — fakes, free
bun run harness --real "<prompt>" # the same turn against real E2B + a real model; this spends money
bun run harness --real --model=anthropic/claude-opus-5 "<prompt>"  # the demo model, ~20x the cost
bun run computer:reliability       # "Test the app" against three correct apps, 10 runs each, on the local
                          # Docker desktop at 2 GiB — scripted model, free; needs Docker. Evidence lands
                          # in computer-reliability-results/. --model=<image model> uses a real one;
                          # anything not :free also needs --allow-spend --max-spend=<usd>, and spends
                          # money. See docs/computer-use-reliability.md
bun run ws:smoke          # drives /ws over a real Bun socket — fakes, free, no database
bun run verify-nap:up     # the real web app, API, Postgres and queue on a scripted model, an in-memory
                          # sandbox and a headless Chrome, for driving a UI change like a user — free;
                          # needs Docker and Chrome. --port=<base> runs a second beside it
bun run verify-nap <cmd>  # drives that Chrome by role and accessible name, and saves screenshots as
                          # evidence: doctor, signin, click, fill, wait, shot, stop… See .agents/skills/verify-nap
bun run loadgen           # scripted users against the composed API — fakes, free; needs Docker
bun run loadgen --users=25        # that many at once, latencies calibrated from a funded run
bun run loadgen:ramp      # the k6 ramp to 100 concurrent turns — fakes, free; needs Docker and k6
                          # ~20 minutes. --profile=smoke (3m), extended (to 400), saturate (to
                          # 1200), realism. Exits non-zero when no degradation was found — see §23
                          # Results land in napload-results/; see docs/scaling-baseline.md
infra/k8s/proof/run.sh    # the three processes on a kind cluster, at API 3 / workers 2 / reaper 1 —
                          # fakes, free; needs Docker and kind, and takes several minutes. Checks the
                          # three claims a manifest cannot make: a turn crossing pods, a cancel
                          # crossing pods well inside a renewal, and a rolling restart losing no
                          # events. `--down` deletes the cluster. See infra/k8s
caffeinate -dimsu infra/k8s/load/run.sh   # the same ramp, against a cluster with the autoscalers running — fakes,
                          # free; needs Docker, kind and k6, and installs KEDA, metrics-server and a
                          # Prometheus so both autoscalers have something to read. ~40 minutes for the
                          # headline profile. --profile=smoke (3m), realism. --down deletes it.
                          # `caffeinate` because a host that sleeps mid-ramp still passes — GOTCHAS.
                          # Results land in napload-results/; see docs/scaling-cluster.md
bun run loadgen:teardown --older-than-minutes=60   # what it would delete: the demo identities a
                          # deployed run left behind, and the sandboxes they still name. Reports and
                          # exits; --confirm is what deletes. DATABASE_URL says which deployment, and
                          # this cannot tell a load run's identity from a real visitor's — read the
                          # script before pointing it at anything shared
bun run napbench <task-id>        # one benchmark run — fakes, free; scores mean nothing
bun run napbench --suite=all      # the four tasks, serially, same fakes — frozen, see docs/NAPBENCH.md
bun run napbench --suite=hard     # the tasks built to separate two models
bun run napbench --suite=product  # the tasks scored on both halves — what it does, and whether it
                          # is a product anybody would want. Free: the judge is scripted, and its
                          # grades mean nothing about any application. See docs/NAPBENCH.md
bun run napbench --real --suite=all  # real E2B + a real model + real Chrome; this spends money
                          # --real needs NAP_CHROME_PATH as well as the usual credentials.
                          # Results (reports, trajectories, screenshots) land in napbench-results/
bun run napbench:corpus   # re-photographs the nine fixture applications an evaluator has to be
                          # able to tell apart — free, needs only a Chrome at NAP_CHROME_PATH.
                          # The PNGs are committed; run this only after changing a fixture, and
                          # re-capture the whole corpus at once. See docs/NAPBENCH.md
bun run napbench:vision-spike --real --model=<id>
                          # one real judgement of one corpus fixture, to confirm a model accepts
                          # image input through the OpenRouter path this repo uses — spends a
                          # fraction of a cent. Nothing may be pinned as the judge before this
                          # says yes about it. Without --real it prints what it would do
bun run napbench:trial run --task=<id> --job-dir=<dir> [-- <napbench flags>]
                          # one task into one job directory, for an external harness to drive —
                          # report.json, trajectory.json and trial.log under fixed names. Shells
                          # out to napbench, so it is free unless `--real` is passed after `--`
bun run napbench:trial verify --job-dir=<dir> --reward-dir=<dir>
                          # projects that report into reward.json, or writes nothing and exits
                          # non-zero when the run measured nothing. See harbor/README.md
bun run harbor:tasks      # regenerates harbor/tasks/ from @nap/bench/suite — free, offline.
                          # Generated, gitignored, and includes a bundled verifier per task
uv run --directory harbor --extra harbor harbor run -d terminal-bench/terminal-bench-2-1 \
  -i terminal-bench/<task> -a nap_harbor.agent:NapAgent -m <openrouter-id> -n 1 -o <jobs-dir>
                          # Nap's agent on Terminal-Bench 2.1 tasks, inside each task's own
                          # container, scored by the task's hidden tests. Free on a `:free` model
                          # (a paid one is refused without NAP_HARBOR_FLAGS=--spend), but each
                          # step is one request against that model's daily quota. Needs Docker.
                          # See harbor/README.md
bun run lint:py           # ruff over harbor/ — the Python no other gate here can see. Needs uv
bun run test:py           # pytest over harbor/ — no evaluation framework required. Needs uv
bun run napbench --baseline=<run-id|path> --candidate=<run-id|path>
                          # what moved between two finished runs — reads reports, runs nothing
bun run typecheck         # turbo: tsc --noEmit per workspace, then a root pass for test/ + configs
bun run lint              # biome check
bun run format            # biome check --write — Biome owns formatting, don't hand-format
bun run build             # turbo build
bun run dev               # turbo dev — api on :3001, web on :3000; copy apps/api/.env.example to .env first
bun run dev:worker        # the second process: claims queued turns and serves nothing. Same database,
                          # same .env; it refuses to boot if the settings are wrong — docs/DEPLOY.md
bun run dev:reaper        # the third: sweeps idle projects, reconciles capacity and closes out
                          # interrupted turns; with a GitHub App configured it also works the
                          # webhook inbox and refreshes stale pull requests. Serves and claims
                          # nothing; exactly one, ever. It
                          # refuses to boot on the wrong settings for the reason the worker does
```

## The Python under `harbor/`

**`harbor/` is Python, and none of those three can see it.** Biome does not read it, `tsc` cannot, vitest collects nothing from it — the exact shape of the mistake the definition of done was written after. Its gates are `bun run lint:py` (ruff) and `bun run test:py` (pytest): lefthook runs both on any commit touching a `*.py`, and CI runs them unconditionally in a job of their own. Editing that directory therefore needs [`uv`](https://docs.astral.sh/uv/) installed; nothing else in the repo does. The claims that span both languages are guarded so that neither toolchain alone misses a drift: for NapBench's adapter, from the TypeScript side in `apps/napbench/src/harbor-agreement.test.ts`; for the Terminal-Bench adapter, by example files both sides' tests read (listed in `harbor/README.md`, "Gates").
