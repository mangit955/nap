# Nap v1 Progress

Current milestone: **M1 — Execution Plane — COMPLETE.** Next up: **M2 — Intelligence Plane**
(branch `feat/m2-intelligence`). M0 and M1 are both merged to `main`.

> Before any M2 work, read the `claude-api` skill rather than answering from memory —
> `CLAUDE.md` explains why that milestone is the one where a stale recollection costs most.

## How to use this file

This file tracks **status only**. What each task actually means is in `docs/PLAN.md` §4,
under the matching ID; how to work in this repo is in `CLAUDE.md`.

Pick the next task whose status is `TODO` **and** whose `Deps` are all `DONE`.
`Deps` are transcribed from `docs/PLAN.md` §4 — if the two ever disagree, the plan wins.

Statuses: `TODO` · `IN_PROGRESS` · `DONE` · `BLOCKED` (with reason) · `SKIPPED` (with reason).

## Tooling & infrastructure

Not `docs/PLAN.md` §4 tasks — repo tooling added alongside the milestones, tracked
here so it isn't mistaken for product work.

| ID | Task | Status | Notes |
|----|------|--------|-------|
| T-1 | Dependency-direction test | DONE | `test/architecture.ts`. PLAN.md §0 called the direction "enforced" but nothing enforced it; now a test does, including "agent must not depend on e2b". Verified by injecting a real violation. |
| T-2 | Hook blocking bare `bun test` | DONE | `.claude/settings.json` PreToolUse. |
| T-3 | `nap-session` skill | DONE | `.claude/skills/nap-session/` — automates the §1 protocol. |
| T-4 | `nap-events` skill | DONE | `.claude/skills/nap-events/` — event test discipline. Updated at M0-3 with the concrete 11-type table and the two jsonb rules (no `Date`/`undefined`, strict payloads). |
| T-5 | GitHub Actions CI | DONE | `.github/workflows/ci.yml` — lint/typecheck/test on push to main + `feat/**`, and on PRs. Integration suite deliberately excluded (costs real spend). |
| T-6 | Permission allowlist | DONE | `.claude/settings.json`. Only `bun run <script>` exact forms — everything else we run (git/gh read-only, jq, rg, grep) is already auto-allowed. No `bun run *` wildcard (arbitrary code execution) and no `test:integration` (the prompt is the only checkpoint before real spend). |
| T-7 | Auto-format on write | DONE | PostToolUse `Write\|Edit` → `biome check --write` on the touched file. Removes the write→lint-fails→format→retry loop. |
| T-8 | Dirty-tree Stop hook | DONE | Warns (does not block) when the tree is dirty at session end — mechanises §1's "never end a session with uncommitted work". |
| T-9 | PLAN↔PROGRESS consistency test | DONE | `test/docs.ts`. The Deps column is a hand transcription of PLAN.md §4; this stops the two silently disagreeing. Verified by injecting drift. |
| T-10 | "Definition of done" gate | DONE | Five-point gate in `CLAUDE.md`, executable form in `nap-session` finish. The retroactive audit that produced it found a real bug: `test/` sat outside typecheck for two commits (T-1, T-9 both shipped unchecked), because package tsconfigs only include `src`. Fixed by a root `tsconfig.json` + `tsc --noEmit` appended to the typecheck script; lefthook and CI inherit it. Audit re-verified T-1…T-9 otherwise sound. |
| T-11 | No-task-IDs-in-source test | DONE | `test/comments.ts`. Task IDs in comments read as tracker residue to anyone outside the project — they date the code instead of explaining it. Found 3 pre-existing cases from M0-1 plus 4 of my own in M0-3, so it was already a habit. Plan *section* refs (`docs/PLAN.md §5`) stay legal. Verified by injecting a real violation. |

## M0 — Scaffold & Contracts

| ID | Task | Deps | Status | Notes |
|----|------|------|--------|-------|
| M0-1 | Workspace scaffold | — | DONE | Bun replaces pnpm (see PLAN.md "Bun/Node split"). Vitest kept — run it as `bun run test`, never `bun test`. Packages resolve to `.ts` source via subpath exports, so no build step for test/typecheck; needs `allowImportingTsExtensions`. |
| M0-2 | `CLAUDE.md` + `PROGRESS.md` | M0-1 | DONE | PROGRESS.md was already seeded during M0-1. Added a `Deps` column so this file alone answers "what's next?", as §1 requires. |
| M0-3 | Event schemas | M0-1 | DONE | zod 4.4.3 (`z.iso.datetime`, `z.strictObject`). Envelope nests `payload` to mirror the `events` row. `createdAt` is an ISO **string** and payloads are strict — both are jsonb survival rules, both proven by breaking them. IDs were left as non-empty strings pending the id format; M0-5 settled on `uuid` and tightened them. |
| M0-4 | Interface declarations | M0-3 | DONE | 8 ports in `packages/shared/src/ports/` + a shared `Result` for expected failures. Two traps found: `*.test-d.ts` files were not collected at all (a deliberately wrong assertion passed) until a `types` project + `tsconfig.test-d.json` were added; and `Omit<NapEvent,"seq">` silently flattens the union, decorrelating `type` from `payload` — needs a distributive omit. Also set `"types": ["node"]` in `tsconfig.base.json`; @types/node was not being auto-included, so `AbortSignal` did not resolve. |
| M0-5 | DB schema + migrations | M0-1 | DONE | drizzle-orm 0.45.2 + postgres.js, migrations committed under `packages/db/drizzle/`. **Deviates from §5:** `events` gets a `turn_id` column — §5 sketches the tables, the event union is the contract and carries `turnId`. IDs are `uuid`, so M0-3's `events.ts` tightened to `z.uuid()`. **`created_at` is `timestamptz` but the contract types `createdAt` as an ISO string** — whatever implements `EventStore` must map with `.toISOString()`; there is a test proving that mapping yields a valid `NapEvent`. New `db` vitest project (one container per run, `*.db.test.ts`); `bun run test:fast` is the Docker-free loop. `projects.status` values are provisional — M4-4 owns that vocabulary. |
| M0-6 | API skeleton + env validation | M0-1 | DONE | Hono 4.13.1 + pino 10.3.1. Required env is only what the API reads today (`DATABASE_URL` + three defaulted keys); later keys sit commented in `.env.example` and become required in the task that reads them. Log context is `AsyncLocalStorage`, so `sessionId`/`turnId` reach code the M0-4 ports give no logger to. **pino is fine under Bun** — plain JSON to a stream, no transports (transports use worker threads; don't add one). **Gotcha found:** turbo's strict env mode meant `DATABASE_URL=… bun run dev` failed until `dev` got a `passThroughEnv`; the normal path is a `.env` file, which Bun auto-loads. Boot failure prints and exits 1 rather than throwing a Zod stack trace. |
| M0-7 | Web skeleton | M0-1 | DONE | **Next 16, not 15** — PLAN.md amended; App Router is unchanged, the "15" predated 16. Tailwind v4 (CSS-first, `@theme` in `globals.css`; Biome needs `css.parser.tailwindDirectives`). New `web` vitest project (jsdom + `@vitejs/plugin-react`, which must live in the *root* devDeps since the root config imports it). **Closed two live gaps: `.tsx` matched no vitest glob, and `test/comments.ts` was blind to every `.tsx` file.** `next-env.d.ts` is gitignored — it references `.next/` artifacts CI never builds, and typecheck is green without it. Render tests query by role + accessible name; that caught four `banner` landmarks from `<header>` inside each pane. |

## M1 — Execution Plane

| ID | Task | Deps | Status | Notes |
|----|------|------|--------|-------|
| M1-1 | `SandboxManager` interface + `InMemorySandboxManager` | M0-4 | DONE | The interface itself already landed in M0-4, so this was the fake + the conformance suite (`packages/sandbox/src/testing/`). **Two contract decisions M1-2 must honour:** post-`destroy` ops return `destroyed`, never `not_found` — the E2B adapter needs to track ids it killed, since E2B alone can't tell the two apart; and `listFiles` returns *direct children only*, with directories synthesized. The suite is parameterised by a harness supplying `root` and two concrete shell commands, because it cannot assume a shell. Unscripted `exec` **throws** rather than returning a bland success — a test running an unscripted command asserts on nothing. Verified by breaking the fake three ways and watching the matching cases fail. |
| M1-2 | E2B adapter | M1-1 | DONE | e2b 2.38.0. **Conformance suite passes 13/13 against real E2B; the orphan check (`Sandbox.getInfo` per created id) is green.** The SDK is injected as a narrow `E2BClient` so error-mapping tests run against a stub with no network — no `vi.mock` needed, contrary to the "Bun/Node split" note in `docs/PLAN.md`. Three divergences found and handled, now in `CLAUDE.md`: `commands.run` throws on non-zero exit; `AuthenticationError` doesn't extend `SandboxError`; an arbitrary sandbox id is a 400, not a 404 — which forced a new `unknownSandboxId()` on the harness, since the suite cannot invent a well-formed id. Handles are cached per sandbox: without it every file op was a fresh `connect` round-trip. `E2B_API_KEY` is read by the integration suite only, so it stays out of `apps/api/src/env.ts` until the server builds a SandboxManager. |
| M1-3 | Project template | M1-2 | DONE | **Cold start (create → sandbox usable): 0.77s / 0.79s / 0.85s / 1.14s over four runs** — dependencies are baked in, so nothing installs at creation. Template `nap-vite-react` (id `uz50ssm54r8rc9n6isll`), built by hand via `bun run template:build`; it is **opt-in** (`new E2BSandboxManager({ template: NAP_TEMPLATE })`), so the M1-2 conformance run stays on the base image. Vite 8 + React 19.2.8 + Tailwind 4.3.3 + Bun. **Four bugs the integration suite caught, none visible locally:** the first build committed all of `node_modules` (no `.gitignore`); the second swept `.profile` and Bun's cache into the repo because the project was rooted at `$HOME` — hence `TEMPLATE_WORKDIR=/home/user/app`; the NodeSource Node 24 install was shadowed by the base image's 20.9 on PATH and did nothing; and the starter app had two type errors. Also relaxed the conformance exec-streaming assertion — cross-stream chunk ordering is not something a real transport promises, and asserting it failed ~1 run in 3. |
| M1-4 | Dev server boot + preview URL | M1-3 | DONE | **Create → preview serves 200: 1.93s / 2.05s / 2.56s / 2.62s** (cold start alone is ~0.9–1.3s; the rest is Vite booting). Verified in a real browser. The template gained `setStartCmd('cd /home/user/app && bun run dev', waitForPort(5173))` as its terminal builder call, so E2B supervises the process and holds `create` open until the port binds. **Added `waitForPreview` to the `SandboxManager` port** — `waitForPort` only proves something bound the port *inside* the sandbox, and the user loads it through a public proxy that becomes ready separately; it polls for a 200 and returns the existing typed `timeout` otherwise. Conformance covers only the timeout and destroyed paths, because it runs against a bare sandbox where success is not observable; the success path lives in the fake's tests and the template integration test. Fake gained `listen(sandboxId, port)` so downstream tests can drive both outcomes without a network. |
| M1-5 | Git helpers | M1-1 | DONE | `commitAll` / `currentSha` / `bundle` / `restoreBundle` in `packages/sandbox/src/git.ts`, free functions over a `SandboxManager`. Round trip verified against real git. **Commit messages are shell-quoted** — they come from a model and are interpolated into a command line, so `$(…)`/backticks/quotes are command injection into the user's sandbox; `shellQuote` is tested by round-tripping ten hostile inputs through a real `sh`, which caught what a naive double-quote version lets through. `git clean -fd` deliberately **without `-x`**, or a restore would delete the baked `node_modules` and turn a 1s open into a reinstall — there is a test for that. No-changes commits are a no-op because read-only turns must not fail. **Known edge:** bundles move as base64 through `exec` stdout (the port has no binary channel), which inflates 33% — fine at v1 sizes, but M4-1 snapshots real projects to R2 and may need `readFileBytes` on the port instead. |

## M2 — Intelligence Plane

| ID | Task | Deps | Status | Notes |
|----|------|------|--------|-------|
| M2-1 | `LLMProvider` + `ScriptedLLMProvider` | M0-4 | IN_PROGRESS | @anthropic-ai/sdk 0.116.0, now exclusive to `@nap/agent` in `test/architecture.ts`. **The M0-4 port could not express the task and was extended:** `LLMRequest` gained `tools` (a model never told about a tool cannot return the `toolCalls` the result already declared) and `LLMMessage.content` widened to a block union so tool results can be fed back; `complete()` moved onto a per-turn handle from `startTurn()`, which makes "usage resets per turn" structural rather than a reset call to forget. **Refusal is typed-only — no server-side `fallbacks`/beta headers** (user decision); M2-7 maps it to `turn.failed`. **`usage.input_tokens` is the uncached remainder**, so cached tokens are summed in — see CLAUDE.md. SDK retries disabled (`maxRetries: 0`) so our own N-attempt policy is the only one and is testable. Everything else is done and all three gates are green. **next: put `ANTHROPIC_API_KEY` in `apps/api/.env` and run `bun run test:integration`** — `claude-provider.integration.test.ts` is written and collected but has never executed, so the real request shape (model id, `xhigh` effort, adaptive thinking, tool schema) is unverified; the stub agrees with anything. Mark DONE once it passes. |
| M2-2 | `MemoryProvider` + `NoopMemoryProvider` | M0-4 | TODO | |
| M2-3 | `ContextEngine` | M2-2, M0-3 | TODO | |
| M2-4 | System prompt | M2-3 | TODO | |
| M2-5 | Sandbox-proxy tools | M1-1, M0-3 | TODO | |
| M2-6 | Safety hooks | M2-5 | TODO | |
| M2-7 | `AgentService` | M2-1, M2-5, M2-6 | TODO | |
| M2-8 | `Runtime` | M2-7, M2-3, M1-5, M0-5 | TODO | |
| M2-9 | CLI harness | M2-8 | TODO | M2 acceptance gate |

## M3 — Presentation & Streaming

| ID | Task | Deps | Status | Notes |
|----|------|------|--------|-------|
| M3-1 | `EventStore` (Postgres) + `EventBus` | M0-5 | TODO | |
| M3-2 | WebSocket endpoint | M3-1 | TODO | |
| M3-3 | Client WS hook + reconnect | M3-2 | TODO | |
| M3-4 | Chat pane | M3-3, M0-3 | TODO | |
| M3-5 | Preview pane | M1-4 | TODO | |
| M3-6 | File tree | M1-1 | TODO | |
| M3-7 | Turn submission wiring | M3-4, M2-8 | TODO | |

## M4 — Persistence

| ID | Task | Deps | Status | Notes |
|----|------|------|--------|-------|
| M4-1 | Snapshot on teardown | M1-5, M0-5 | TODO | |
| M4-2 | Restore on open | M4-1, M1-3 | TODO | |
| M4-3 | Idle reaper | M4-1 | TODO | |
| M4-4 | Project CRUD + list page | M0-5, M4-2 | TODO | |
| M4-5 | Full-cycle integration test | M4-2, M4-3 | TODO | |

## M5 — Auth & Hardening

| ID | Task | Deps | Status | Notes |
|----|------|------|--------|-------|
| M5-1 | Auth | M0-5 | TODO | |
| M5-2 | Authorization on every route | M5-1, M4-4 | TODO | |
| M5-3 | Rate limits & quotas | M5-1 | TODO | |
| M5-4 | Error surfaces | M3-4, M3-5 | TODO | |
| M5-5 | Observability baseline | M0-6 | TODO | |
| M5-6 | v1 acceptance run | all | TODO | record cost/latency per turn here |
