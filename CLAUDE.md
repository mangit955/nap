# CLAUDE.md

Nap is a Lovable-style AI app builder: the user describes an app in chat, an agent writes code into an isolated E2B sandbox, and a live preview updates as it works. It is built task by task across many sessions, so **start every session with the protocol at the bottom of this file.**

## Where things are written down

| File | Answers | Read it |
|---|---|---|
| `docs/PLAN.md` | *What* v1 is; the spec and full task list (§4) | Every session, per its §1 |
| `CLAUDE.md` (this file) | *How* to work here — commands, conventions, gotchas | Auto-loaded |
| `PROGRESS.md` | *Where* we are — status and deps per task | Every session |

Keep each fact in exactly one of these. This file must never restate a task spec — link to `docs/PLAN.md` §4 instead.

## Commands

```bash
bun run test              # unit suite — fakes only, deterministic, no network
bun run test:integration  # real E2B + real Anthropic; run at milestone boundaries only
bun run typecheck         # tsc --noEmit across all workspaces, via turbo
bun run lint              # biome check
bun run format            # biome check --write — Biome owns formatting, don't hand-format
bun run build             # turbo build
bun run dev               # turbo dev
```

> ⚠️ **Always `bun run test`, never `bun test`.** `test` is a Bun built-in command that shadows the package.json script; bare `bun test` runs Bun's own runner over our Vitest files and reports nonsense.

A lefthook pre-commit hook runs `biome check` + `typecheck` + `vitest --changed`. It will block the commit if any fail — fix the cause, don't bypass it. The same three gates run in CI (`.github/workflows/ci.yml`) on every push to `main` and `feat/**`, so `--no-verify` only defers the failure.

## Conventions

- **TypeScript strict.** No `any`. No non-null `!` except in tests.
- **Zod at every boundary** — env vars, HTTP bodies, WebSocket frames, persisted event payloads. Infer types from schemas; never hand-write a type alongside its schema.
- **Errors:** typed result objects for *expected* failures (sandbox unavailable, budget exceeded); thrown exceptions only for programmer error.
- **No barrel files** re-exporting across packages. Import the specific module.
- **Every exported function gets a test before it gets an implementation.** Write the test, watch it fail for the right reason, then implement.

## Layout

```
packages/  shared  db  sandbox  agent  context  runtime
apps/      web (Next.js)   api (Hono, runs on Bun)
```

**Dependency direction, enforced:** `runtime` → {`context`, `agent`, `sandbox`, `db`} → `shared`.
`agent` imports the `SandboxManager` *interface*, never the E2B adapter.

This is enforced by `test/architecture.ts`, not by vigilance — adding a dependency that
violates it fails `bun run test`. Adding a new workspace package also fails the test until
you add it to the rule table there.

## Component ownership

Drift here is the most expensive kind of mistake. Before adding code to a component, check it belongs there.

| Component | Owns | Never does |
|---|---|---|
| `Runtime` | Turn lifecycle: acquire sandbox → build context → run agent → persist → publish → commit → snapshot. Budgets, cancellation, recovery. | Prompt content, model params, tool implementations |
| `ContextEngine` | Assembling context and owning the token budget + truncation order | Calling the model; deciding when a turn ends |
| `AgentService` | Driving the model loop for one turn; executing proxy tools; emitting typed events | Persistence, git, sandbox lifecycle, prompt assembly |
| `LLMProvider` | Model id, effort, thinking config, refusal/fallback policy, retries, usage accounting | Vendor abstraction — it is *not* a cross-vendor swap |
| `MemoryProvider` | `retrieve()` / `write()`. v1 is `NoopMemoryProvider` | Anything in v1 — but its call sites are real |
| `SandboxManager` | Sandbox lifecycle, filesystem, exec, preview URL | Knowing what an agent or a turn is |
| `EventStore` / `EventBus` | Durable append, **then** fanout — in that order | Business logic |

**Where tools execute:** the Claude Agent SDK's built-in `Read`/`Write`/`Edit`/`Bash` act on the API server's filesystem, not the sandbox. Built-ins stay **disabled**; every file and shell operation goes through custom tools that proxy to `SandboxManager`.

## Testing

- **`*.test.ts` → unit suite. `*.integration.test.ts` → integration suite.** Filename decides, not directory, so both can sit side by side in one package.
- Unit tests are deterministic and free. **If a test needs the network, it belongs in `test:integration`.**
- **Never assert on model prose.** Assert on tool-call sequences, event types and ordering, and filesystem effects.
- Fakes live in `packages/*/src/testing/` and are exported. They are production-quality code — every downstream package's tests depend on them.

## Repo-specific gotchas

Learned the hard way; don't rediscover them.

- **Packages resolve to TypeScript source**, via `"exports": { "./*": "./src/*.ts" }` in each `package.json`. Import as `@nap/shared/version`, not `@nap/shared`. There is no build step for tests or typecheck, and no root barrel to import from — which is what enforces the no-barrel-files rule.
- **Relative imports need an explicit `.ts` extension** (`allowImportingTsExtensions` is on in `tsconfig.base.json`). Safe because `tsc` never emits — Vite and Bun do the transpiling.
- **Adding a cross-package dependency requires re-running `bun install`** to create the workspace symlink, or the import resolves at typecheck but fails at runtime.
- **Bun installs and dispatches; Node executes.** `bun run` honours a binary's shebang, so Vitest and Next.js run under Node. Only `apps/api` and our own entrypoints use the Bun runtime. This is deliberate — see "Bun/Node split" in `docs/PLAN.md`.

## Session protocol

**Starting:**
1. `git status` and `git log --oneline -10`.
2. Read `PROGRESS.md`.
3. Run `bun run test` — **confirm green before starting new work.** If red, fixing it is the session's first task.
4. Pick the next `TODO` task whose deps are all `DONE`.
5. Mark it `IN_PROGRESS` in `PROGRESS.md` and commit that single-line change.

**Finishing a task:**
1. `bun run test` and `bun run typecheck` — both must pass.
2. Mark it `DONE` in `PROGRESS.md`, with a one-line note on anything surprising.
3. Commit: `feat(<scope>): <task id> <summary>`, tests included.

**Stopping mid-task:** commit `wip(<scope>): <task id> — <what's left>` and leave the task `IN_PROGRESS` with a "next step" note.

> **Never end a session with uncommitted work.** A future session cannot recover context that exists only in a dirty working tree.

Branch per milestone (`feat/m0-scaffold`, `feat/m1-execution-plane`, …), one commit per completed task.
