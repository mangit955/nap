# Nap v1 Progress

Current milestone: **M0 — Scaffold & Contracts**   (branch: `feat/m0-scaffold`)

Task definitions live in `docs/PLAN.md` §4. This file tracks status only.
Statuses: `TODO` · `IN_PROGRESS` · `DONE` · `BLOCKED` (with reason) · `SKIPPED` (with reason).

> Seeded at M0-1 so the session protocol has something to read. M0-2 owns the
> full conventions write-up in `CLAUDE.md`.

## M0 — Scaffold & Contracts

| ID | Task | Status | Notes |
|----|------|--------|-------|
| M0-1 | Workspace scaffold | DONE | Bun replaces pnpm (see PLAN.md "Bun/Node split"). Vitest kept — run it as `bun run test`, never `bun test`. Packages resolve to `.ts` source via subpath exports, so no build step for test/typecheck; needs `allowImportingTsExtensions`. |
| M0-2 | `CLAUDE.md` + `PROGRESS.md` | IN_PROGRESS | |
| M0-3 | Event schemas | TODO | |
| M0-4 | Interface declarations | TODO | |
| M0-5 | DB schema + migrations | TODO | |
| M0-6 | API skeleton + env validation | TODO | apps/api is a placeholder until this task |
| M0-7 | Web skeleton | TODO | apps/web is a placeholder until this task |

## M1 — Execution Plane

| ID | Task | Status | Notes |
|----|------|--------|-------|
| M1-1 | `SandboxManager` interface + `InMemorySandboxManager` | TODO | |
| M1-2 | E2B adapter | TODO | |
| M1-3 | Project template | TODO | record cold-start time here |
| M1-4 | Dev server boot + preview URL | TODO | |
| M1-5 | Git helpers | TODO | |

## M2 — Intelligence Plane

| ID | Task | Status | Notes |
|----|------|--------|-------|
| M2-1 | `LLMProvider` + `ScriptedLLMProvider` | TODO | |
| M2-2 | `MemoryProvider` + `NoopMemoryProvider` | TODO | |
| M2-3 | `ContextEngine` | TODO | |
| M2-4 | System prompt | TODO | |
| M2-5 | Sandbox-proxy tools | TODO | |
| M2-6 | Safety hooks | TODO | |
| M2-7 | `AgentService` | TODO | |
| M2-8 | `Runtime` | TODO | |
| M2-9 | CLI harness | TODO | M2 acceptance gate |

## M3 — Presentation & Streaming

| ID | Task | Status | Notes |
|----|------|--------|-------|
| M3-1 | `EventStore` (Postgres) + `EventBus` | TODO | |
| M3-2 | WebSocket endpoint | TODO | |
| M3-3 | Client WS hook + reconnect | TODO | |
| M3-4 | Chat pane | TODO | |
| M3-5 | Preview pane | TODO | |
| M3-6 | File tree | TODO | |
| M3-7 | Turn submission wiring | TODO | |

## M4 — Persistence

| ID | Task | Status | Notes |
|----|------|--------|-------|
| M4-1 | Snapshot on teardown | TODO | |
| M4-2 | Restore on open | TODO | |
| M4-3 | Idle reaper | TODO | |
| M4-4 | Project CRUD + list page | TODO | |
| M4-5 | Full-cycle integration test | TODO | |

## M5 — Auth & Hardening

| ID | Task | Status | Notes |
|----|------|--------|-------|
| M5-1 | Auth | TODO | |
| M5-2 | Authorization on every route | TODO | |
| M5-3 | Rate limits & quotas | TODO | |
| M5-4 | Error surfaces | TODO | |
| M5-5 | Observability baseline | TODO | |
| M5-6 | v1 acceptance run | TODO | record cost/latency per turn here |
