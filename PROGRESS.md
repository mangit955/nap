# Nap v1 Progress

Current milestone: **M0 — Scaffold & Contracts**   (branch: `feat/m0-scaffold`)

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
| T-4 | `nap-events` skill | DONE | `.claude/skills/nap-events/` — event test discipline. Written pre-M0-3, so it covers rules not shapes; revisit after M0-3. |
| T-5 | GitHub Actions CI | DONE | `.github/workflows/ci.yml` — lint/typecheck/test on push to main + `feat/**`, and on PRs. Integration suite deliberately excluded (costs real spend). |

## M0 — Scaffold & Contracts

| ID | Task | Deps | Status | Notes |
|----|------|------|--------|-------|
| M0-1 | Workspace scaffold | — | DONE | Bun replaces pnpm (see PLAN.md "Bun/Node split"). Vitest kept — run it as `bun run test`, never `bun test`. Packages resolve to `.ts` source via subpath exports, so no build step for test/typecheck; needs `allowImportingTsExtensions`. |
| M0-2 | `CLAUDE.md` + `PROGRESS.md` | M0-1 | DONE | PROGRESS.md was already seeded during M0-1. Added a `Deps` column so this file alone answers "what's next?", as §1 requires. |
| M0-3 | Event schemas | M0-1 | TODO | |
| M0-4 | Interface declarations | M0-3 | TODO | |
| M0-5 | DB schema + migrations | M0-1 | TODO | |
| M0-6 | API skeleton + env validation | M0-1 | TODO | apps/api is a placeholder until this task |
| M0-7 | Web skeleton | M0-1 | TODO | apps/web is a placeholder until this task |

## M1 — Execution Plane

| ID | Task | Deps | Status | Notes |
|----|------|------|--------|-------|
| M1-1 | `SandboxManager` interface + `InMemorySandboxManager` | M0-4 | TODO | |
| M1-2 | E2B adapter | M1-1 | TODO | |
| M1-3 | Project template | M1-2 | TODO | record cold-start time here |
| M1-4 | Dev server boot + preview URL | M1-3 | TODO | |
| M1-5 | Git helpers | M1-1 | TODO | |

## M2 — Intelligence Plane

| ID | Task | Deps | Status | Notes |
|----|------|------|--------|-------|
| M2-1 | `LLMProvider` + `ScriptedLLMProvider` | M0-4 | TODO | |
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
