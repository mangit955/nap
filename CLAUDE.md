# CLAUDE.md

Nap is a Lovable-style AI app builder: the user describes an app in chat, an agent writes code into an isolated E2B sandbox, and a live preview updates as it works. It is built task by task across many sessions, so **start every session with the protocol at the bottom of this file.**

## Where things are written down

| File | Answers | Read it |
|---|---|---|
| `docs/PLAN.md` | *What* v1 was; its spec and full task list (§4). Frozen | When touching something v1 built |
| `CLAUDE.md` (this file) | *How* to work here — commands, conventions, gates | Auto-loaded |
| `docs/GOTCHAS.md` | *Why* the code is shaped this way — hard-won constraints, per area | The section for whatever you are about to touch |
| `PROGRESS.md` | *Where v1 got to* — status and deps per v1 task, and the running-a-checkout notes. Frozen | For the checkout notes, and v1 history |
| `docs/DEPLOY.md` | *How it is deployed* — the Railway/Vercel services, what replaced each reason for the retired one-replica rule, what each process scales and drains on, the env list, and the four silent mistakes the Kubernetes manifests exist to avoid | Before touching anything that runs in production |
| `infra/k8s/README.md` | *What the multi-pod deployment is made of* — the objects, what each one guards, and the two kind clusters: one that proves the claims a manifest cannot, one that runs the ramp against the autoscalers | Before touching a manifest, or scaling past one replica |
| `CONTEXT.md` | *What things are called* — one concept, one name | Before naming a concept in code, a test or an issue |
| `docs/NAPBENCH.md` | *How the agent is measured* — the benchmark's architecture, scoring, how to add a task, what needs a sandbox or a browser | Before touching `packages/bench` or `apps/napbench`, or quoting a score |
| `docs/napbench-*.md` | *What funded runs found* — one write-up per run that spent money, each recording something no dry run could have caught | Before spending on a real benchmark run, or quoting one |
| `docs/scaling-design.md` | *What V2 was built to* — the queue's semantics, the state machines, the invariants, the tests required. Delivered; sections are cited from shipped source, and where one disagrees with the code an ADR says why | Before changing anything the queue, the leases or the fanout rest on |
| `docs/scaling-baseline.md` | *What the system did before it was changed* — the k6 ramp's numbers, and the three §24 questions it answered | Before changing anything on the admission hot path, or quoting a load figure |
| `docs/scaling-cluster.md` | *What the system does now* — the same ramp against a multi-pod cluster with both autoscalers running, compared stage by stage against the baseline, and the §21 invariants each marked demonstrated or not | Before quoting a scaled figure, or claiming an invariant holds |
| `docs/adr/` | *What was decided and why* — choices expensive to reverse | The ADRs touching whatever you are about to change |
| `apps/web/src/docs/` | *What the public is told about how it works* — the `/docs` page, eight sections over the same ground as the README | Before changing any mechanism a reader was promised, or adding architecture prose to `README.md` |

Keep each fact in exactly one of these. This file must never restate a task spec — link to `docs/PLAN.md` §4 instead.

**`README.md` and `/docs` divide one subject and must not both explain it.** The README states *consequences* — what the system does for somebody deciding whether to care — and links onward. `apps/web/src/docs/` states *mechanisms*, and **mechanism numbers live only there**: the repair bound, the category weights, the ceilings. Nothing enforces this, so it is worth reading twice before adding a paragraph to either. *Measurement results* are the one exception: a funded run's headline figures — arms, n, spend, what moved — live in `docs/napbench-*.md` and nowhere in `/docs`, so the README quoting them duplicates nothing. It may; it may not quote mechanism numbers alongside them.

## Commands

```bash
bun run test              # unit + type + db suites — deterministic and free; db needs Docker
bun run test:fast         # unit + type only — the Docker-free inner loop
bun run test:integration  # needs something external; run at milestone boundaries only
                          # most of it is real E2B + real model calls and costs money — but not
                          # all: the browser suites need only a Chrome at NAP_CHROME_PATH and
                          # skip without one. Each file's doc comment says what it requires.
bun run harness "<prompt>"        # one turn, printing the event stream — fakes, free, no network
bun run harness --real "<prompt>" # the same turn against real E2B + a real model; this spends money
bun run harness --real --model=anthropic/claude-opus-5 "<prompt>"  # the demo model, ~20x the cost
bun run ws:smoke          # drives /ws over a real Bun socket — fakes, free, no database
bun run loadgen           # scripted users against the composed API — fakes, free; needs Docker
bun run loadgen --users=25        # that many at once, latencies calibrated from a funded run
bun run loadgen:ramp      # the k6 ramp to 100 concurrent turns — fakes, free; needs Docker and k6
                          # ~20 minutes. --profile=smoke (3m), extended (to 400), saturate (to
                          # 1200), realism. Exits non-zero when no degradation was found — see §23
                          # Results land in napload-results/; see docs/scaling-baseline.md
infra/k8s/proof/run.sh    # the three processes on a kind cluster, at API 3 / workers 2 / reaper 1 —
                          # fakes, free; needs Docker and kind, and takes several minutes. Checks the
                          # two claims a manifest cannot make: a turn crossing pods, and a rolling
                          # restart losing no events. `--down` deletes the cluster. See infra/k8s
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
bun run napbench --real --suite=all  # real E2B + a real model + real Chrome; this spends money
                          # --real needs NAP_CHROME_PATH as well as the usual credentials.
                          # Results (reports, trajectories, screenshots) land in napbench-results/
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
                          # interrupted turns. Serves and claims nothing; exactly one, ever. It
                          # refuses to boot on the wrong settings for the reason the worker does
```

> ⚠️ **Always `bun run test`, never `bun test`.** `test` is a Bun built-in command that shadows the package.json script; bare `bun test` runs Bun's own runner over our Vitest files and reports nonsense.

A lefthook pre-commit hook runs `biome check` + `typecheck` + `vitest --changed`. It will block the commit if any fail — fix the cause, don't bypass it. The same three gates run in CI (`.github/workflows/ci.yml`) on every push to `main` and `feat/**`, so `--no-verify` only defers the failure.

## Definition of done

**No task, step, or feature is complete until all five hold.** This is a gate, not a checklist to skim — work through it before marking anything `DONE`.

1. **Gates pass.** `bun run test`, `bun run typecheck`, `bun run lint`. Read the real output. Never infer success from having written the code.
2. **Anything that guards must be seen to fail.** For a check, validator, test, or enforcement rule: deliberately break the thing it protects and confirm it catches the breakage, then revert. *A check that has never been observed failing is not known to work* — it may be silently passing on everything.
3. **Integration review — the step that gets skipped.** Ask explicitly, every time:
   - **Is the new code inside *every* existing gate?** A new directory is not automatically typechecked or linted. Verify, don't assume.
   - Does it interact with the hooks in `.claude/settings.json`, lefthook, or CI?
   - Does any existing test, script, config, or glob need to learn that it exists?
   - Do `CLAUDE.md`, `docs/PLAN.md`, and `PROGRESS.md` still describe reality after this change?
4. **The task's own "Done when"** from `docs/PLAN.md` §4 is satisfied literally. It is often stricter than "tests pass" — e.g. M2-7 wants ordering tests green *10 runs in a row*; M1-3 wants a recorded cold-start time.
5. **Tree clean and committed.**

> This rule exists because it was earned. `test/` shipped outside typecheck: the suite was green, the new tests passed, and two enforcement modules sat unchecked for two commits. Step 1 passed while step 3 was never asked.

## Conventions

- **TypeScript strict.** No `any`. No non-null `!` except in tests.
- **Zod at every boundary** — env vars, HTTP bodies, WebSocket frames, persisted event payloads. Infer types from schemas; never hand-write a type alongside its schema.
- **Errors:** typed result objects for *expected* failures (sandbox unavailable, budget exceeded); thrown exceptions only for programmer error.
- **No barrel files** re-exporting across packages. Import the specific module.
- **Every exported function gets a test before it gets an implementation.** Write the test, watch it fail for the right reason, then implement.
- **Read a library's installed types before writing against it** — `node_modules/<pkg>/**/*.d.ts`, not memory. Every version surprise in this repo so far was found this way and none would have been caught by recall: zod 4 moved to `z.iso.datetime()` and a two-arg `z.record()`, drizzle 0.45's table-extras callback returns an *array*, pino takes `(options, stream)`, Next exports a `Viewport` type. Checking costs one `grep`; being wrong costs a debugging session.
- **An env key becomes required in the task that first reads it.** `apps/api/src/env.ts` validates only what the API uses today; `apps/api/.env.example` lists the rest commented out. A boot check that fails on credentials nothing uses teaches people to paste dummy values, which is worse than no check.
- **Comments explain why, and address a reader who has never seen the plan.** No task IDs (`M2-5`) in any package's or app's `src` — they are bookkeeping, they say *when* code was written rather than *why* it is the way it is, and they point at a tracker the reader cannot open. Cite a section instead (`docs/PLAN.md §5`), or just say the reason. Enforced by `test/comments.ts`; `test/` and `docs/` are exempt.

## Layout

```
packages/  shared  db  sandbox  storage  capture  agent  context  runtime  verify  bench  loadgen
apps/      web (Next.js)   api (Hono, runs on Bun)   napbench (the benchmark CLI)
```

**`apps/api` is three processes, not one.** `src/index.ts` serves and executes nothing; `src/worker.ts` executes and serves nothing; `src/reaper.ts` sweeps and does neither, as **exactly one replica** guarded by an advisory lock. All three call `bootNap` in `src/boot.ts`, which builds the real clients and hands them to the one `composeNap` — the role it passes decides which loops start. Adding a dependency means touching `boot.ts` once, never three times. See `docs/DEPLOY.md`.

**Dependency direction, enforced:** `runtime` → {`context`, `agent`, `sandbox`, `storage`, `capture`, `db`, `verify`} → `shared`. `agent` imports the `SandboxManager` *interface*, never the E2B adapter.

- **`bench` sits beside `shared`** rather than above `runtime`: it is NapBench's pure half — tasks, scoring, gates, reports — written against ports, and `apps/napbench` is the shell that composes real infrastructure behind them. Playwright belongs to that app alone and to nothing that ships. See `docs/adr/0001`.
- **`loadgen` sits beside `bench`** and for the same reason: percentile maths, metric rollup, threshold verdicts, degradation rules, k6-summary parsing and the scripted user's ordering, written against ports and knowing nothing about a socket or a server. `apps/api/scripts/loadgen-composition.ts` is the shell that composes the real API with a fake sandbox and a fake model against a real Postgres; `loadgen.ts` drives it with in-process users and `loadgen-ramp.ts` holds it open for k6.
- **`verify` sits *below both* `runtime` and `bench`**: running one check against a sandbox and saying whether it passed, failed or was never asked. The runtime uses it to arbitrate a turn's claim; the benchmark uses it to build a score. The edge that must never exist is `runtime` → `bench` — the system under test importing the thing that grades it. See `docs/adr/0007`.

This is enforced by `test/architecture.ts`, not by vigilance, and at both ends: one rule reads every package's `package.json`, a second reads the `@nap/*` specifiers its `src` and `scripts` actually import — type-only ones included, because Bun hoists workspace packages and an undeclared import otherwise resolves, typechecks and ships. Either way `bun run test` goes red. Three things hold:

- Every file may only import a package its manifest declares.
- Shipped source — `src`, minus the tests — may only import what the table above allows, and must have it as a real `dependency`. Tests and `scripts/` answer to the manifest but not the table, which is how sibling packages arrive as devDependencies for their fakes.
- `@nap/bench` is the exception to that exemption: nothing below `apps/napbench` may import it, tests included. See `docs/adr/0007`.

Adding a new workspace package also fails the test until you add it to the rule table there.

## Component ownership

Drift here is the most expensive kind of mistake. Before adding code to a component, check it belongs there.

| Component | Owns | Never does |
|---|---|---|
| `TurnQueue` | The durable queue of turn requests and the per-session leases that make one exclusive: enqueue, claim, renew, settle, cancel. **One in-flight request per session cluster-wide, enforced by a partial unique index** rather than by any caller remembering. Also the one answer to **"is this session busy?"** — `anyLeased`, which close, delete and the idle sweep all ask, so busy means the same thing in every process | Running anything. Holding a credential — it records *whether* the asker pays, never their key. Deciding who may start a turn, which is the route's |
| `TurnWorker` | Claiming a request, renewing its lease, running it through the `Runtime`, settling the row — and **aborting the turn the moment a renewal says the lease is gone**. Draining on shutdown: stop claiming, wait, keep renewing throughout, abort what is left at the deadline. It is what `apps/api/src/worker.ts` is | Admission, ceilings, model access. Deciding *what* a turn does — it drives the `Runtime` and owns none of it. Serving anything |
| `Runtime` | Turn lifecycle: log the prompt → acquire sandbox → build context → run agent → persist → publish → commit → verify → snapshot → photograph. **The prompt is first and is drained before the acquisition**, so a project's first turn shows its author something while the workspace is still coming up. Budgets, cancellation, recovery. **Reserving sandbox capacity at the point of creation** — the authoritative ceiling, since a queued turn may not create anything for a minute — and **reconciling it on the reaper's tick**, so a slot no path gave back comes back in minutes rather than never. Opening and closing the **job** a turn belongs to, arbitrating the turn's claim against the project's own checks, and continuing a job an open found still open (ADR-0006) | Prompt content, model params, tool implementations. Deciding *which* checks exist or how to run one — that is `@nap/verify`'s. Deciding *what* the ceiling is — the limits belong to the composition. Continuing a job nobody asked to see |
| `ContextEngine` | Assembling context and owning the token budget + truncation order | Calling the model; deciding when a turn ends |
| `AgentService` | Driving the model loop for one turn; executing proxy tools; emitting typed events | Persistence, git, sandbox lifecycle, prompt assembly |
| `LLMProvider` | Model *policy* — effort, thinking config, refusal/fallback, retries, usage accounting — and the default model. A turn may override **two** things through `startTurn({ model, credentials })` and nothing else: which model, and whose account pays. Both are facts about who asked rather than preferences, which is why they vary per turn while everything else here does not | Vendor abstraction — it is *not* a cross-vendor swap. Deciding *which* models are allowed, or which key a caller has: that is the route's, via `resolveTurnAccess` |
| `MemoryProvider` | `retrieve()` / `write()`. v1 is `NoopMemoryProvider` | Anything in v1 — but its call sites are real |
| `SandboxManager` | Sandbox lifecycle, filesystem, exec, preview URL | Knowing what an agent or a turn is |
| `SandboxInventory` | What the provider says it is running, for whoever has lost track of one. Separate port, for the reason `ping` is: it asks about the deployment, not about a project | Destroying anything, or deciding what unreferenced means |
| `PageCapture` | Turning a URL that is already serving into PNG bytes | Waiting for a dev server, deciding when to photograph, or knowing where the picture is kept. Deciding how many may happen at once — that is the composition's, since it depends on the worker's concurrency |
| `EventStore` / `EventBus` | Durable append, **then** fanout — in that order | Business logic |

**Where tools execute:** we run no agent harness with built-in tools, because a harness's `Read`/`Write`/`Edit`/`Bash` act on the API server's filesystem, not the sandbox. `AgentService` owns its own loop over the `LLMProvider` port, and **the only tools that exist are the six in `packages/agent/src/tools/`**, every one of which proxies to `SandboxManager`. See `docs/PLAN.md` §0.

## Testing

- **`*.test.ts` → unit. `*.test-d.ts` → types. `*.test.tsx` → web. `*.db.test.ts` → db. `*.integration.test.ts` → integration.** Filename decides, not directory, so all five can sit side by side in one package. Each project exists because it needs a different *environment* — node, tsc, jsdom, a Postgres container — not for tidiness. The `.ts` infix names still match `*.test.ts`, so each of those must also be *excluded* from `unit` or it runs twice.
- **A test in the wrong project is not collected, and silently passes.** This has now bitten twice: `*.test-d.ts` files ran nowhere until the `types` project existed, and `.tsx` matched no glob at all. After adding any suite, run `vitest list --project <name>` and confirm the file appears — do not infer it from a green run.
- **Component tests query by role and accessible name**, never class names or test ids. The panes are placeholders that later tasks replace wholesale, so markup-anchored assertions would break on contact with the real thing; a role query also fails when a landmark is unreachable to a screen reader, which is worth catching.
- **The `db` suite runs against a real Postgres in a throwaway container**, one per run, migrated by `globalSetup`. It is deterministic and free, so `docs/PLAN.md` §3 keeps it in the default suite — but it needs Docker and costs seconds, hence `test:fast`. Tests share the container, so none of them may assume an empty table. Assert on SQLSTATE codes (`23505`, `23503`), not driver message text: drizzle wraps errors, so `.message` is `"Failed query: …"` and the real reason is on `.cause`.
- **Type tests are compile-time only, so they need their own runner.** `expectTypeOf` has no runtime effect: without the `types` project in `vitest.config.ts`, a `*.test-d.ts` file is never collected and a *wrong* assertion in it passes silently. That project needs `tsconfig.test-d.json` — the root `tsconfig.json` covers only `test/`, and each package's covers only its own `src`, so neither is a program containing every type test. `bun run typecheck` catches these too, via each package's own tsconfig; the two are deliberate belt and braces.
- Unit tests are deterministic and free. **If a test needs the network, it belongs in `test:integration`.**
- **Never assert on model prose.** Assert on tool-call sequences, event types and ordering, and filesystem effects.
- Fakes live in `packages/*/src/testing/` and are exported. They are production-quality code — every downstream package's tests depend on them.

## Repo-specific gotchas

The hard-won constraints live in `docs/GOTCHAS.md`, grouped by area, because most of them do not apply to most sessions. **Read the sections your task touches before you write code in that area** — every one of them is there because somebody already lost a session to it.

| Touching… | Read `docs/GOTCHAS.md` § |
|---|---|
| package layout, imports, `bun`, turbo, biome, Next config | Workspace, build and tooling |
| types, schemas, the event contract, env parsing | Types and data contracts |
| `packages/agent`, prompts, caching, streaming, OpenRouter, cost | Model and provider |
| `packages/sandbox`, `packages/storage`, snapshots, the reaper | Sandbox and storage |
| `apps/api` — routes, auth, limits, logging, `/health`; the turn queue and leases; the three entrypoints and what each one starts | API, auth and logging |
| `apps/web` — components, the landing page, browser checks | Web and UI |
| writing tests, fakes, mutation checks | Testing |
| `packages/loadgen`, `apps/api/k6`, the ramp, a baseline run | Load testing |

## Session protocol

> **Where the task list lives changed after v1.** `docs/PLAN.md` §4 and `PROGRESS.md` are the frozen record of v1 and are no longer added to. V2 work is GitHub issues — a wayfinder map with child tickets, blocked via GitHub's native issue dependencies, so "what is next" is a query rather than a table read by eye. See `docs/agents/issue-tracker.md`.

**Starting:**
1. `git status` and `git log --oneline -10`.
2. Run the frontier query — the V2 map's open children, dropping any with an open blocker or an assignee, first in map order wins.
3. Run `bun run test` — **confirm green before starting new work.** If red, fixing it is the session's first task.
4. Read the `docs/GOTCHAS.md` sections that ticket touches — nothing loads them for you.
5. Claim it: `gh issue edit <n> --add-assignee @me`. That is the session's first write, and it replaces the old `IN_PROGRESS` commit.

**Finishing a task:**
1. `bun run test` and `bun run typecheck` — both must pass.
2. Commit: `feat(<scope>): <summary>`, tests included. **No task IDs in commit subjects** — issue numbers go in the body as `Closes #<n>`, which is what links them.
3. Close the issue with a comment on anything surprising, then append a pointer to the map's Decisions-so-far.

**Stopping mid-task:** commit `wip(<scope>): <what's left>`, and leave a comment on the issue saying what the next step is. Keep the assignee.

Branch per milestone (`feat/m0-scaffold`, `feat/m1-execution-plane`, …), one commit per completed task.

> **Never end a session with uncommitted work, or with an open working tree and no issue comment.** A future session cannot recover context that exists only in a dirty working tree; the commit and the comment together are the handoff, and either alone loses the half a future session needs.

## Agent skills

| Skill | What it covers | See |
|---|---|---|
| Issue tracker | Issues live as GitHub issues in `mangit955/nap`, via the `gh` CLI. The v1 task list stays frozen in `docs/PLAN.md` §4 and `PROGRESS.md`; V2 onwards is issues | `docs/agents/issue-tracker.md` |
| Triage labels | The five canonical roles, each label string equal to its name | `docs/agents/triage-labels.md` |
| Domain docs | Single-context — one root `CONTEXT.md` (the glossary) plus `docs/adr/` (decisions that would be expensive to reverse). Read the glossary before naming a concept, and the ADRs that touch whatever you are about to change | `docs/agents/domain.md` |
