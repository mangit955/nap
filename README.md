# Nap

**Describe an app. Then go take a nap.**

A durable coding-agent runtime for long-running software work.

A model saying it is finished is a claim, not a fact. Nap commits the work, verifies it against the
project's own checks, and turns verified commits into *checkpoints*; failed checks can trigger
bounded repair.

**[Live demo](https://nap-tawny.vercel.app)** ·
[Docs](https://nap-tawny.vercel.app/docs) ·
[Architecture](https://nap-tawny.vercel.app/docs#architecture) ·
[Scale](https://nap-tawny.vercel.app/docs#scale) ·
[NapBench](https://nap-tawny.vercel.app/docs#napbench)

[![CI](https://github.com/mangit955/nap/actions/workflows/ci.yml/badge.svg)](https://github.com/mangit955/nap/actions/workflows/ci.yml)

![A prompt for a finance dashboard, the agent reading files and running the project's checks, the
verdict "Verified successfully with both npm run typecheck and npm run build", and the app it
built](docs/demo.gif)

<sub>Twenty-two seconds of a real run: the prompt, a tool call into the sandbox, the project's own
checks running, the verdict, and the app on its own URL. The whole session — two minutes, uncut —
is at the top of **[/docs](https://nap-tawny.vercel.app/docs)**. Both come out of
`scripts/demo-cuts.sh`, from one recording, so they cannot drift apart.</sub>

Built solo across the runtime, agent, sandbox, persistence, evaluation and web layers.

> **Evidence:** 2 funded measurements · 12 real runs · $0.15. The experiments did not establish a
> score improvement; they did expose and fix a real verifier blind spot. [Full results →](#evidence)

---

## Why Nap

Coding agents can write code. What they cannot yet do is survive the gap between asking and
finishing, and everything expensive lives in that gap:

- Processes restart mid-work. Sandboxes are billed by the second and do not outlive being idle.
- In-memory state disappears with the process holding it, and a spinner is not a record.
- A model announces success at some rate whether or not it has succeeded.
- Code that a model called done can still fail to typecheck, build or serve.

Nap's answer is a sequence rather than a feature: **treat completion as a claim, persist the work,
verify the result, repair what failed, and resume from durable state.** Each step below exists
because one of the four problems above is otherwise unanswerable.

## What Nap does

- **A prompt becomes a running app.** The agent writes files into a fresh E2B sandbox, runs
  commands, and a Vite dev server serves the result behind a preview URL. Every step streams to the
  browser as it happens.
- **The work is durable, and the transcript is the source of truth.** Events are appended to
  Postgres with a monotonic `seq` before anyone sees them. Close the tab mid-turn and reopening asks
  for everything after the last event it saw — no duplicates, no holes.
- **Nothing you closed was running in your request.** A turn is admitted, enqueued and claimed by a
  worker; the socket you were watching from is not the process doing the work, so the tab is
  genuinely optional. A deploy drains rather than stops — the worker quits claiming, keeps renewing
  what it holds, and finishes it. A worker that dies outright is a different promise, and a smaller
  one: the turn is closed out rather than silently retried, and the job it belonged to stays open
  for whoever opens the project next.
- **A turn that changed files is committed, then verified** against checks discovered from the
  project's own `package.json`, run cheapest-first and short-circuiting at the first failure.
- **A failure opens a repair Turn**, bounded per job, carrying the failure into the next attempt's
  context.
- **Coming back is a first-class screen, not a scroll to the bottom.** The transcript opens at the
  seam where your reading stopped, and if something was *decided* while you were gone — a job
  verified, a job abandoned — one card above the seam says what. Nothing was decided, no card.
- **An idle project is put away, not left running.** The workspace is committed, the git repository
  bundled to object storage and the sandbox destroyed. The next message restores it.

## The loop

```
user prompt
    │
    ▼
  Job ──────────► Turn ──► agent work ──► commit
    ▲                                        │
    │                                        ▼
    │                                  verification
    │                                        │
    │                    ┌───────────────────┴───────────────────┐
    │                    ▼                                       ▼
    │                  passed                                 failed
    │                    │                                       │
    │                    ▼                                       ▼
    └──── job.checkpointed                          repair Turn (≤3) ──┐
                         │                                             │
                         ▼                                             │
                   job.completed  ◄───────────────────────────────────┘
                                        (or attempts exhausted)
```

Two words carry the weight, and they are not synonyms:

| | Means | Recorded by |
|---|---|---|
| **commit** | durable workspace state | every completed turn that mutated files |
| **checkpoint** | *verified* workspace state | `job.checkpointed`, with its sha |

"Last known-good" means last checkpoint, so a failed verification cannot corrupt it — by
construction rather than by care, and `HEAD == last checkpoint` makes "is this project currently
valid" a fact rather than a judgement somebody renders by reading the chat.

Two further properties follow. **A job has no table behind it:** what was asked, how far it has got
and what has been verified are a fold over the same events the transcript is folded from, so there
is one source of truth and resuming is replaying. And **a repair is an ordinary Turn** — which is
why no new machinery was needed for it. Budgets, cancellation, event ordering, streaming and
commit-on-completion all apply to a repair unchanged, because it is not a new kind of thing.

[The loop in full →](https://nap-tawny.vercel.app/docs#verification) ·
[Phases and bounds →](https://nap-tawny.vercel.app/docs#durable-jobs)

## Architecture

```
Browser (Next.js)                         ← Presentation Plane
   │ HTTPS + WebSocket
API server (Hono on Bun)                  ← API Gateway/BFF + Session Service + Streaming Hub
   │   admits a turn, enqueues it, holds the socket — and executes nothing
   ▼
turn_requests (Postgres)                  ← the durable queue; one leased turn per session
   │
Worker  claim ─► renew ─► settle          ← executes turns, serves nothing
   └── Runtime  (turn orchestration)      ← Intelligence Plane
         ├── ContextEngine ──► MemoryProvider (no-op today)
         ├── AgentService  ──► LLMProvider
         ├── SandboxManager ──────────────► E2B sandbox   ← Execution / Control Plane
         ├── EventStore (Postgres)                          /workspace (git repo)
         ├── EventBus (Postgres NOTIFY)                     vite dev :5173 → preview URL
         └── Verifier ─────────────────────► the project's own checks

Reaper (exactly one)                      ← the idle sweep, capacity reconciliation, the janitor
```

**Three processes, one image, no call between them.** `apps/api/src/index.ts` serves and executes
nothing, `worker.ts` executes and serves nothing, `reaper.ts` does neither and runs as a single
replica behind an advisory lock. All three call one `bootNap`, so a new dependency is one edit
rather than three. A turn reaches a worker through the `turn_requests` table and nothing else, and
an event reaches your browser as a `NOTIFY` carrying a session and a `seq` — never a payload — after
which the pod holding your socket reads the events out of the log it was already going to trust.
That is what lets the socket you are on and the process running your turn be different machines.

A thin vertical slice through all five planes, and the boundaries are the point. `Runtime` owns the
turn lifecycle and never owns prompt content. `ContextEngine` owns the token budget and truncation
order, and never calls the model. `AgentService` drives one turn's model loop and never touches
persistence or git. `SandboxManager` knows nothing about agents or turns. `EventStore` appends
before `EventBus` fans out — always, because the reverse lets a client see an event a crash then
loses.

That direction is enforced by a test rather than by discipline. `test/architecture.ts` checks
`runtime → {context, agent, sandbox, storage, capture, db, verify} → shared` at both ends — every
package's manifest, and every `@nap/*` specifier its source actually imports, type-only ones
included. Adding a violating import fails `bun run test`; adding a workspace package fails it until
you declare the package's rule. `agent` imports the `SandboxManager` *interface* and never the E2B
adapter, which is what makes swapping E2B for something else a one-package change rather than an
audit.

**The full table — every component, what it owns and what it must never do — is on the
[docs page](https://nap-tawny.vercel.app/docs#architecture), with the package graph beside it.**

## Evidence

Verification's *value* has been measured twice against real infrastructure, and both write-ups are
in this repo in full. **Neither established that the loop improves scores.** That is the honest
headline, and the reasons are worth more than the number would have been.

| | Model | Design | Spend |
|---|---|---|---|
| [First measurement](docs/napbench-verification-measurement.md) | `gpt-5.6-terra` | `hard` suite, n=3 per arm, verification off vs. on | $0.134 |
| [Re-measurement](docs/napbench-luna-remeasurement.md) | `gpt-5.6-luna` | identical, after the fixes below | $0.0153 |

**What they established.** Across twelve real runs, the system executed the verification path
against real E2B sandboxes and a real model with no infrastructure failures. And the first
measurement found a verifier blind spot that no dry run could have: the sandbox template declared
no `typecheck` script, so check discovery read three of five checks `absent` and a job that did not
typecheck was reported `verified` — the grader looking harder than the guard. That drove a template
fix, regression coverage, and an integration case that runs `bun run typecheck` inside a real
sandbox. The re-measurement confirmed `typecheck` is arbitrated now, in a real run rather than
inferred from a manifest.

**What they did not.** No funded run triggered a repair turn. The second measurement produced one
meaningful separation between the arms, but the failing run exposed a product-level visual error —
an app that compiled, built and served while rendering the wrong thing — that the current check set
does not detect. Attributing that gap to verification would be claiming credit for catching a
defect the loop demonstrably does not see, so the write-up does not, and neither does this README.

The open question is therefore the loop's *reach*, not its correctness: behavioural checks belong to
NapBench today, deliberately ([ADR-0007](docs/adr/0007-the-check-primitive-moves-below-both.md)),
which leaves the observer strictly more capable than the system it observes. Whether that boundary
should move is a design question rather than a measurement one.

**A third real session paid for something neither of those could.** Four turns of one project
against real E2B and a real model, the fourth of which died on `budget_exceeded`. Its whole event
log is committed unedited at `apps/web/src/testing/audit-session.json`, so the failure is now
reproducible for free — replaying it through the real assembler is what showed the truncation ladder
had never run, and what
[ADR-0011](docs/adr/0011-an-old-turns-tool-traffic-is-not-worth-carrying.md) is built on. It doubles
as the fixture the job history and the seam were designed against: hand-written events are uniformly
too tidy to ask a layout question of.

[How the agent is measured →](https://nap-tawny.vercel.app/docs#napbench)

### And what it does under load

Separately, and for nothing: the same k6 ramp was run against one process
([baseline](docs/scaling-baseline.md)) and then against a nine-pod Kubernetes cluster with both
autoscalers live ([cluster](docs/scaling-cluster.md)) — three API pods, two-to-four workers, one
reaper, KEDA on queue depth and an HPA on open sockets. At 100 concurrent turns the cluster ran
**2,310 turns with 100% job, turn and verification completion, zero sequence gaps, zero duplicates
and zero WebSocket failures**, including 219 mid-turn reconnects that each asked for the gap and got
exactly it. The model and the sandbox are the same fakes at recorded speeds, so what the ramp
measures is the architecture and not the vendor — which is the whole reason it costs nothing to run
again.

Both write-ups say what is still marginal as plainly as what passed; `queue_wait` is the number to
watch, and it is named as such rather than buried.

## Decisions worth defending

**A completed turn is a claim, not a fact.**
*Why:* the failure mode is the harness believing the model. A model that writes a type error is not
misbehaving; what makes the error expensive is Nap filing it as a success, committing it, and
showing a preview pointed at a dev server that is now failing to build.
*Trade-off:* a repair needs the broken code present in order to fix it, so the broken code must be
committed — which is why commit and checkpoint had to separate rather than verification simply
gating the commit. And because a repair is an ordinary Turn, anything that assumed one user message
begets one turn now sees up to four.
[ADR-0006](docs/adr/0006-a-completed-turn-is-a-claim-not-a-fact.md)

**A checkpoint is a verified commit.**
*Why:* "last known-good" has to mean something a machine can evaluate. `HEAD == last checkpoint` is
a fact; "the chat looks fine" is not.
*Trade-off:* exhausting the three attempts does not revert. The code stays committed, `HEAD`
diverges from the last checkpoint, and the job says so — because reverting would throw away work a
user can frequently push over the line with one more sentence.

**Durable append, then fanout — in that order.**
*Why:* this is the one that makes leaving work. Publishing first is faster, and it lets a client see
an event that a crash then loses, after which the browser and the database disagree and nothing can
say which is right. Because the order is fixed, catching up is a single question: everything after
`seq`.
*Trade-off:* every event pays a database round-trip before anyone sees it. In exchange, a reconnect
an hour later is the same operation as a reconnect a second later.
[ADR-0010](docs/adr/0010-event-fanout-is-notify-then-read.md)

**A turn executes on a worker, behind a table — not in the request that asked for it.**
*Why:* while the API process was the worker, a request's lifetime was the turn's lifetime, so a
deploy was a lost turn and there was nothing to scale independently. Worse, two API replicas would
accept two turns for one session, each acquire a sandbox, and leave the project paying for one that
nothing references. Exclusivity is now a partial unique index rather than a `Map` somebody has to
remember, so "this session is busy" means the same thing in every process.
*Trade-off:* Postgres is a worse queue than Redis or JetStream, deliberately. Everything those buy
is aimed at *redelivery*, and a redelivered turn is a second model run somebody pays for — the
event log, not the queue, is what makes recovery correct here, so a queue with no path back to
`queued` is the feature.
[ADR-0009](docs/adr/0009-turns-execute-on-workers-behind-a-postgres-queue.md)

**An old turn's tool traffic is not worth carrying, even when it fits.**
*Why:* a funded four-turn session died on the fourth, having assembled to a fifth of its context
budget. Two ceilings exist and the one that fires is not the one people reach for: a turn re-sends
its whole transcript on every round trip, so its bill is the assembled size *times* its step count.
The truncation ladder was perfectly correct and had never run. So tool traffic from any turn older
than the most recent is emptied unconditionally, before the budget is consulted — the call keeps its
shape, prose on both sides is untouched, and the file contents from three commits ago go.
*Trade-off:* an agent cannot re-read what it wrote earlier out of its own history, and must call
`read_file` again. That is one cheap call against re-sending the file ten to forty times.
[ADR-0011](docs/adr/0011-an-old-turns-tool-traffic-is-not-worth-carrying.md)

**A job has no table; it is a fold over the log.**
*Why:* one source of truth. The same events the transcript is folded from answer what was asked, how
far it got and what has been verified — so resuming is replaying, and a trivial request that closes
in one turn and a large one spanning six need not be distinguished in advance.
*Trade-off:* a process restart leaves a job open, and **only a person opening the project continues
it.** A supervisor that picked up open jobs on its own would be an autonomous loop spending tokens
with nobody watching; a crash loop plus auto-continue is a large bill for nothing.

**No agent harness, and the six tools are the reason.**
*Why:* a batteries-included agent SDK ships built-in `Read`/`Write`/`Edit`/`Bash`, and those act on
the filesystem of the process running the harness — here the API server, not the user's sandbox. So
`AgentService` drives the model loop itself over an `LLMProvider` port, and the only tools that
exist are the six in [`packages/agent/src/tools/`](packages/agent/src/tools) — `read_file`,
`write_file`, `edit_file`, `list_files`, `search_files`, `run_command` — each proxying to
`SandboxManager`.
*Trade-off:* the loop, retries, streaming and usage accounting are all ours to maintain. In return
there is no reachable filesystem but the sandbox's, which is stronger than disabling built-ins
because there is no toggle to get wrong.

**An idle project is snapshotted, not paused.**
*Why:* keeping a sandbox alive so a project stays openable means paying for a machine nobody is
using. The reaper commits the workspace, bundles the git repository to R2 and destroys the sandbox;
restore is the inverse.
*Trade-off:* "come back tomorrow" stops being a billing problem and becomes a cold start. It is also
why the snapshot bytes and their bookkeeping are separate ports — they fail independently, and
teardown ordering is only expressible if they do.

## Stack

TypeScript (strict, no `any`) · Bun · Hono · Next.js · Postgres + Drizzle · Zod at every boundary ·
E2B · OpenRouter · Cloudflare R2 · Better Auth · Kubernetes, with KEDA on queue depth and an HPA on
open sockets · Vitest · Playwright (benchmark only) · k6 · Biome · Turborepo

## Running it

**Prerequisites:** [Bun](https://bun.sh) · Docker (for Postgres and the `db` test suite) ·
an [E2B](https://e2b.dev) key · an [OpenRouter](https://openrouter.ai/keys) key ·
a [Cloudflare R2](https://developers.cloudflare.com/r2/) bucket.

```bash
bun install
docker compose -f infra/docker-compose.yml up -d   # Postgres
cp apps/api/.env.example apps/api/.env             # then fill it in
bun run db:migrate
bun run dev                                        # web on :3000, api on :3001
bun run dev:worker                                 # a second terminal — this is what runs turns
bun run dev:reaper                                 # a third, optional: the idle sweep
```

**The worker is not optional if you want a turn to happen.** The API admits a turn and writes it to
the queue; nothing in that process executes it. Running the API alone gets you a prompt that is
accepted, a job that opens, and then silence. The worker needs `NAP_EVENT_BUS=postgres` in the same
`.env` — it refuses to boot otherwise rather than running turns whose events reach no browser, which
is a bug that looks like a broken front end. The reaper is genuinely optional in development: skip
it and idle projects simply keep their sandboxes, which on a laptop costs nothing but E2B minutes.

Five variables are required and the API refuses to boot without them, naming every problem at once
rather than one per restart:

| Variable | What it is |
|---|---|
| `DATABASE_URL` | Matches `infra/docker-compose.yml` as shipped |
| `E2B_API_KEY` | The sandboxes a turn runs in |
| `OPENROUTER_API_KEY` | Which account pays for the model |
| `BETTER_AUTH_SECRET` | Signs session cookies — `openssl rand -base64 32` |
| `NAP_KEY_ENCRYPTION_SECRET` | Seals stored API keys — `openssl rand -base64 32`, must decode to exactly 32 bytes |

Plus the four `R2_*` variables: a server that can destroy sandboxes but has nowhere to snapshot them
is worse than one that does neither. GitHub and Google sign-in are optional but both-or-neither per
provider — boot refuses half an OAuth app, because otherwise it fails at the redirect back rather
than at startup. `apps/api/.env.example` documents every variable and why it exists.

**Using the hosted demo?** Use Chrome or Firefox. The app and its API are on two different sites, so
the session cookie is third-party, and Safari and Brave block those outright. Deploying your own is
[docs/DEPLOY.md](docs/DEPLOY.md).

### The free path

Most of this codebase can be exercised without spending anything or holding any credential:

```bash
bun run harness "build a todo list"   # a whole turn against fakes — no network, no spend
bun run test:fast                     # unit + type suites; no Docker, no credentials
bun run ws:smoke                      # drives /ws over a real socket, no database
bun run napbench <task-id>            # one benchmark run against fakes
bun run loadgen --users=25            # scripted users against the composed API; needs Docker
bun run loadgen:ramp                  # the k6 ramp to 100 concurrent turns; needs Docker and k6
infra/k8s/proof/run.sh                # the three processes on a kind cluster, proving a turn
                                      # crosses pods and a rolling restart loses no events;
                                      # needs Docker and kind
infra/k8s/load/run.sh                 # the same ramp against a cluster with both autoscalers
                                      # live — this is what produced the cluster figures above.
                                      # Needs Docker, kind and k6, and runs for ~40 minutes
```

Every external dependency sits behind a port with a production-quality fake in
`packages/*/src/testing/`, which is what makes that possible — and it is why the scaling work above
could be measured at all, rather than argued about. Add `--real` to the harness or to `napbench` to
run against a real sandbox and a real model; that spends money, and nothing else here does.

## Testing

```bash
bun run test          # unit + type + web + db — deterministic, free, needs Docker
bun run test:fast     # the Docker-free inner loop
bun run typecheck     # per-workspace tsc, then a root pass
bun run lint          # biome
```

**3,894 tests across 289 files.** Four suites, split by the *environment* each needs rather than for
tidiness: node, `tsc` (compile-time type assertions), jsdom, and a throwaway Postgres container
started per run. The filename decides which suite collects a test, so all four can sit side by side
in one package.

Two rules that earned their place. **Never assert on model prose** — assert on tool-call sequences,
event types and ordering, and filesystem effects, which are the things that are actually
contractual. And **anything that guards must be seen to fail**: a check nobody has watched break is
not known to work, it may be silently passing on everything.

> ⚠️ Always `bun run test`, never `bun test` — `test` is a Bun built-in that shadows the
> package.json script and runs Bun's own runner over Vitest files, reporting nonsense.

The same three gates run on pre-commit and in CI on every push.

## Where it stands

**Deployed and open at [nap-tawny.vercel.app](https://nap-tawny.vercel.app)** — no account needed,
with turns on a free-tier model under tight ceilings, or bring your own key to unlock the paid
models and bill turns to yourself.

v1 built the vertical slice: contracts and scaffold, the execution plane, the agent loop, streaming
and presentation, persistence, and auth with hardening. **V2 is complete** — durable jobs, the
verification and repair loop, checkpoints, continuing an open job when a project is next opened, and
NapBench, the harness that measures the agent. Its spec is frozen in [`docs/PLAN.md`](docs/PLAN.md);
work since then is GitHub issues.

**Since V2, two things.** Execution left the request: the turn queue and its per-session leases, the
worker and reaper processes, cross-process fanout, and Kubernetes manifests with both autoscalers,
measured against a ramp to 100 concurrent turns. And the loop became visible to the person who left
— the job strip and the history behind it, the seam a transcript opens at, and the one card that
says what was decided while nobody was watching.

Ceilings exist on everything that costs money, because an unattended agent with an open-ended budget
is a bill with no ceiling: per-user turn rate limits, per-user and deployment-wide sandbox
quotas, a token budget per turn, and a step budget per agent loop.

### Deliberately not built

Each of these is a scope boundary with its seam already in place, which is a different claim from a
roadmap:

| Not built | Seam that exists today |
|---|---|
| Sandboxes as Kubernetes pods, instead of E2B | `SandboxManager`, plus a conformance suite in `packages/sandbox/src/testing/conformance.ts` that any implementation must pass. *Nap's own three processes already run on Kubernetes — [`infra/k8s`](infra/k8s) — which is a different thing: that is where the app runs, this is where a user's app would* |
| Redis Streams event bus | `EventBus`; two implementations ship — in-process, and one over Postgres `LISTEN`/`NOTIFY` that crosses process boundaries |
| Long-term memory | `MemoryProvider` — `NoopMemoryProvider` today, with real call sites in `ContextEngine` |
| Multi-agent | `Runtime` — fan out to several `AgentService` runs, join their event streams |
| Billing | Per-turn usage already accumulated by `LLMProvider` |
| Monaco editing, terminal | The file tree already reads from the sandbox filesystem |

## More

- **[The docs page](https://nap-tawny.vercel.app/docs)** — how it works and why it is built this
  way, at length: the event model, durable jobs, verification and repair, sandboxes and snapshots,
  and how the agent is measured. This README states the consequences; that states the mechanisms.
- [`docs/adr/`](docs/adr) — the decisions that would be expensive to reverse, one file each
- [`docs/NAPBENCH.md`](docs/NAPBENCH.md) — the benchmark's architecture, scoring and how to add a
  task, alongside the two funded measurement write-ups
- **Scaling**, in four parts: [`scaling-design.md`](docs/scaling-design.md) is what it was built to
  — the queue's semantics, the state machines, the invariants;
  [`scaling-baseline.md`](docs/scaling-baseline.md) is what one process did;
  [`scaling-cluster.md`](docs/scaling-cluster.md) is what nine pods do, compared stage by stage; and
  [`infra/k8s/README.md`](infra/k8s/README.md) is the objects themselves and the two kind clusters —
  one that proves the claims a manifest cannot make, one that runs the ramp against the autoscalers
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — the deployed services, the env list, and the four silent
  mistakes the Kubernetes manifests exist to avoid
- [`docs/GOTCHAS.md`](docs/GOTCHAS.md) — the hard-won constraints, grouped by area, each one written
  down because it cost a session
- [`CLAUDE.md`](CLAUDE.md) — how to work in this repo: commands, conventions, the definition of done
