# AGENTS.md

Nap is an open-source cloud coding agent. You describe a change in chat; an agent works on the
project in its own isolated cloud machine — files, a terminal, and a desktop with a browser it can
see and click — runs the project's checks, can test the running app and record what it saw, and
leaves a verified commit or a pull request. It is built task by task across many sessions, so
**start every session with the protocol at the bottom of this file.**

This file is a map. Each fact lives in exactly one of the files below; this one must never restate
them, nor a task spec — link to it instead.

## Where things are written down

| File | Answers | Read it |
|---|---|---|
| `docs/architecture.md` | Layout, dependency rules, which component owns what | Before adding code to a component |
| `docs/commands.md` | Every script: what it needs and what it costs | Before running anything beyond the everyday commands below |
| `docs/testing.md` | How the suites are split, what a test may assert | Before adding a suite or a test file kind |
| `docs/gotchas/` | *Why* the code is shaped this way — one file per area | The file for whatever you are about to touch (table below) |
| `CONTEXT.md` | What things are called — one concept, one name | Before naming a concept in code, a test or an issue |
| `docs/adr/` | What was decided and why — choices expensive to reverse | The ADRs touching whatever you are about to change |
| `docs/DEPLOY.md` | How it is deployed (Render + Vercel), what each process scales and drains on | Before touching anything that runs in production |
| `docs/computer-use.md` | The desktop, the `computer` tool and "Test the app", and what has been verified | Before touching computer use |
| `docs/NAPBENCH.md`, `harbor/README.md` | How the agent is measured, locally and under an external harness | Before touching `packages/bench`, `apps/napbench` or `harbor/`, or quoting a score |
| `docs/napbench-*.md` | What funded runs found | Before spending on a real run, or quoting one |
| `apps/web/src/docs/` | What the public is told about how it works (`/docs`) | Before changing a mechanism a reader was promised |
| `docs/PLAN.md`, `PROGRESS.md` | What v1 was and where it got to. Frozen | When touching something v1 built |

**`README.md` and `/docs` divide one subject.** The README states *consequences* and links onward;
`apps/web/src/docs/` states *mechanisms*, and mechanism numbers (the repair bound, the category
weights, the ceilings) live only there. A funded run's headline figures live in `docs/napbench-*.md`
and may be quoted in the README, never beside mechanism numbers. Nothing enforces this.

**Frozen areas.** Load testing, the Kubernetes deployment and NapBench's product judge keep their
code and reports but are not being built on: see `docs/scaling-baseline.md` and
`docs/scaling-cluster.md` (load and cluster runs, and the ramp's gotchas), `infra/k8s/README.md`
(the manifests), and `docs/NAPBENCH.md` (the judge). Their commands are in `docs/commands.md`.

## Everyday commands

```bash
bun install               # also in every fresh worktree
bun run test              # unit + types + web + db + computer — free; db needs Docker
bun run test:fast         # unit + types + web — the Docker-free inner loop
bunx vitest run --project unit <file> -t "<name>"  # one test; .tsx is --project web. A -t matching nothing still passes
bun run typecheck         # tsc per workspace, then a root pass for test/ and configs
bun run lint              # biome check; `bun run format` writes — Biome owns formatting
bun run dev               # api :3001, web :3000; copy apps/api/.env.example to .env first
bun run dev:worker        # executes turns; same .env. bun run dev:reaper sweeps — exactly one
bun run harness "<prompt>"         # one turn against fakes — free, no network
bun run harness --real "<prompt>"  # real E2B and a real model — spends money
bun run computer:local    # the whole app on a local Docker desktop, scripted model — free
bun run verify-nap:up     # the real web app on fakes, to drive a UI change like a user — free. See .agents/skills/verify-nap
bun run napbench <task-id>         # one benchmark run on fakes; --real spends money
bun run test:integration  # real services; most of it costs money — milestone boundaries only
```

**Always `bun run test`, never `bun test`** — the bare form runs Bun's own runner over Vitest
files. Anything that spends money (`--real`, `test:integration`) needs the user's approval first.
A lefthook pre-commit hook runs Biome, typecheck and `vitest --changed`, and CI runs the same gates
on every push; fix the cause, never `--no-verify`. `harbor/` is Python and has its own gates,
`bun run lint:py` and `bun run test:py` (need `uv`).

## Definition of done

**Nothing is complete until all five hold.**

1. **Gates pass** — `bun run test`, `bun run typecheck`, `bun run lint`, read from real output.
2. **Anything that guards is seen to fail.** Break what a check protects, watch it catch the
   breakage, revert. A check never observed failing is not known to work.
3. **Integration review.** Is the new code inside *every* gate — typecheck, lint, a collected test
   project (`vitest list --project <name>`)? Does a hook, CI, glob or `test/architecture.ts` need to
   learn it exists? Do this file and the docs it points to still describe reality?
4. **The task's own "Done when"** is met literally — often stricter than "tests pass".
5. **Tree clean and committed.**

## Conventions

- **TypeScript strict.** No `any`; no non-null `!` outside tests.
- **Zod at every boundary** — env, HTTP bodies, WebSocket frames, persisted events. Infer types
  from schemas; never hand-write one beside its schema.
- **Typed result objects for expected failures**; throw only for programmer error.
- **No barrel files.** Import the specific module (`@nap/shared/version`).
- **Every exported function gets a test first**, watched failing for the right reason.
- **Read a library's installed types before writing against it** — `node_modules/<pkg>/**/*.d.ts`,
  not memory.
- **An env key becomes required in the change that first reads it**, never before.
- **Comments explain why, to a reader who has never seen the plan.** No task IDs in `src`
  (enforced by `test/comments.ts`); cite a doc section or say the reason.
- **Never assert on model prose** — assert on tool calls, events and their order, and files.

## Architecture rules

Full detail, and the component ownership table, in `docs/architecture.md`.

- **Dependency direction, enforced by `test/architecture.ts`:** `runtime` → {`context`, `agent`,
  `sandbox`, `storage`, `capture`, `db`, `verify`} → `shared`. `bench` and `loadgen` sit beside
  `shared`; `verify` sits below both `runtime` and `bench`. **`runtime` never imports `bench`**, and
  nothing below `apps/napbench` imports `@nap/bench`. A new workspace package fails the test until
  it is added to the rule table there.
- **`apps/api` is three processes from one image** — `index.ts` serves, `worker.ts` executes turns,
  `reaper.ts` sweeps (exactly one) — all composed once by `bootNap` in `src/boot.ts`.
- **Tools run in the sandbox, never on the API host.** The tool set is declared in
  `packages/agent/src/tools/definitions.ts` and chosen per turn by `toolset.ts`; `TOOL_NAMES` is only
  ever added to. `computer` is offered only to image-capable models when a desktop is composed.
- **Event store before event bus**: append durably, then fan out.

## Gotchas

Read the file for the area you are about to touch — nothing loads them for you.

| Touching… | Read |
|---|---|
| package layout, imports, `bun`, turbo, Biome, Next config | `docs/gotchas/workspace.md` |
| types, schemas, the event contract, env parsing | `docs/gotchas/contracts.md` |
| `packages/agent`, prompts, caching, streaming, OpenRouter, cost | `docs/gotchas/model.md` |
| `packages/sandbox`, `packages/storage`, snapshots, the desktop, the reaper | `docs/gotchas/sandbox.md` |
| `apps/api` — routes, auth, limits, logging, the queue and leases, the three entrypoints | `docs/gotchas/api.md` |
| `apps/web` — components, the landing page, browser checks | `docs/gotchas/web.md` |
| writing tests, fakes, mutation checks | `docs/gotchas/testing.md` |
| load testing or the kind clusters (frozen) | `docs/scaling-baseline.md`, "Gotchas from running the ramp" |

## Session protocol

V1's task list is frozen in `docs/PLAN.md` §4 and `PROGRESS.md`. Work since is GitHub issues in
`mangit955/nap` — a wayfinder map with child tickets and native dependencies
(`docs/agents/issue-tracker.md`).

**Starting:** `git status` and `git log --oneline -10`; run the frontier query (the map's open
children with no open blocker and no assignee, first in map order); `bun run test` must be green
before new work; read the gotchas for the area; claim the issue
(`gh issue edit <n> --add-assignee @me`) as the session's first write.

**Finishing:** `bun run test` and `bun run typecheck` pass; commit `feat(<scope>): <summary>` with
its tests — no task IDs in subjects, `Closes #<n>` in the body; close the issue with a comment on
anything surprising and add a pointer to the map's Decisions-so-far.

**Stopping mid-task:** commit `wip(<scope>): <what's left>`, comment the next step on the issue,
keep the assignee. **Never end a session with uncommitted work or without that comment** — the
commit and the comment together are the handoff.

## Agent skills

| Skill | What it covers | See |
|---|---|---|
| Issue tracker | GitHub issues via `gh` | `docs/agents/issue-tracker.md` |
| Triage labels | The five canonical roles | `docs/agents/triage-labels.md` |
| Domain docs | `CONTEXT.md` and `docs/adr/` | `docs/agents/domain.md` |
