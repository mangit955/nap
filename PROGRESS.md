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
| M0-3 | Event schemas | M0-1 | DONE | zod 4.4.3 (`z.iso.datetime`, `z.strictObject`). Envelope nests `payload` to mirror the `events` row. `createdAt` is an ISO **string** and payloads are strict — both are jsonb survival rules, both proven by breaking them. IDs are non-empty strings, not UUIDs: M0-5 owns the id format and may tighten. |
| M0-4 | Interface declarations | M0-3 | DONE | 8 ports in `packages/shared/src/ports/` + a shared `Result` for expected failures. Two traps found: `*.test-d.ts` files were not collected at all (a deliberately wrong assertion passed) until a `types` project + `tsconfig.test-d.json` were added; and `Omit<NapEvent,"seq">` silently flattens the union, decorrelating `type` from `payload` — needs a distributive omit. Also set `"types": ["node"]` in `tsconfig.base.json`; @types/node was not being auto-included, so `AbortSignal` did not resolve. |
| M0-5 | DB schema + migrations | M0-1 | IN_PROGRESS | |
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
