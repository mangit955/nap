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
bun run test              # unit + type + db suites — deterministic and free; db needs Docker
bun run test:fast         # unit + type only — the Docker-free inner loop
bun run test:integration  # real E2B + real Anthropic; run at milestone boundaries only
bun run typecheck         # turbo: tsc --noEmit per workspace, then a root pass for test/ + configs
bun run lint              # biome check
bun run format            # biome check --write — Biome owns formatting, don't hand-format
bun run build             # turbo build
bun run dev               # turbo dev — starts apps/api; copy apps/api/.env.example to .env first
```

> ⚠️ **Always `bun run test`, never `bun test`.** `test` is a Bun built-in command that shadows the package.json script; bare `bun test` runs Bun's own runner over our Vitest files and reports nonsense.

A lefthook pre-commit hook runs `biome check` + `typecheck` + `vitest --changed`. It will block the commit if any fail — fix the cause, don't bypass it. The same three gates run in CI (`.github/workflows/ci.yml`) on every push to `main` and `feat/**`, so `--no-verify` only defers the failure.

## Definition of done

**No task, step, or feature is complete until all five hold.** This is a gate, not a checklist to skim — work through it before marking anything `DONE`.

**1. Gates pass.** `bun run test`, `bun run typecheck`, `bun run lint`. Read the real output. Never infer success from having written the code.

**2. Anything that guards must be seen to fail.** For a check, validator, test, or enforcement rule: deliberately break the thing it protects and confirm it catches the breakage, then revert. *A check that has never been observed failing is not known to work* — it may be silently passing on everything.

**3. Integration review — the step that gets skipped.** Ask explicitly, every time:

   - **Is the new code inside *every* existing gate?** A new directory is not automatically typechecked or linted. Verify, don't assume.
   - Does it interact with the hooks in `.claude/settings.json`, lefthook, or CI?
   - Does any existing test, script, config, or glob need to learn that it exists?
   - Do `CLAUDE.md`, `docs/PLAN.md`, and `PROGRESS.md` still describe reality after this change?

**4. The task's own "Done when"** from `docs/PLAN.md` §4 is satisfied literally. It is often stricter than "tests pass" — e.g. M2-7 wants ordering tests green *10 runs in a row*; M1-3 wants a recorded cold-start time.

**5. Tree clean and committed.**

> This rule exists because it was earned. `test/` shipped outside typecheck: the suite was green, the new tests passed, and two enforcement modules sat unchecked for two commits. Step 1 passed while step 3 was never asked.

## Conventions

- **TypeScript strict.** No `any`. No non-null `!` except in tests.
- **Zod at every boundary** — env vars, HTTP bodies, WebSocket frames, persisted event payloads. Infer types from schemas; never hand-write a type alongside its schema.
- **Errors:** typed result objects for *expected* failures (sandbox unavailable, budget exceeded); thrown exceptions only for programmer error.
- **No barrel files** re-exporting across packages. Import the specific module.
- **Every exported function gets a test before it gets an implementation.** Write the test, watch it fail for the right reason, then implement.
- **Comments explain why, and address a reader who has never seen the plan.** No task IDs (`M2-5`) in any package's or app's `src` — they are bookkeeping, they say *when* code was written rather than *why* it is the way it is, and they point at a tracker the reader cannot open. Cite a section instead (`docs/PLAN.md §5`), or just say the reason. Enforced by `test/comments.ts`; `test/` and `docs/` are exempt.

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

- **`*.test.ts` → unit. `*.test-d.ts` → types. `*.db.test.ts` → db. `*.integration.test.ts` → integration.** Filename decides, not directory, so all four can sit side by side in one package. The infix names still match `*.test.ts`, so each new suite must also be *excluded* from `unit` in `vitest.config.ts` or it runs twice.
- **The `db` suite runs against a real Postgres in a throwaway container**, one per run, migrated by `globalSetup`. It is deterministic and free, so `docs/PLAN.md` §3 keeps it in the default suite — but it needs Docker and costs seconds, hence `test:fast`. Tests share the container, so none of them may assume an empty table. Assert on SQLSTATE codes (`23505`, `23503`), not driver message text: drizzle wraps errors, so `.message` is `"Failed query: …"` and the real reason is on `.cause`.
- **Type tests are compile-time only, so they need their own runner.** `expectTypeOf` has no runtime effect: without the `types` project in `vitest.config.ts`, a `*.test-d.ts` file is never collected and a *wrong* assertion in it passes silently. That project needs `tsconfig.test-d.json` — the root `tsconfig.json` covers only `test/`, and each package's covers only its own `src`, so neither is a program containing every type test. `bun run typecheck` catches these too, via each package's own tsconfig; the two are deliberate belt and braces.
- Unit tests are deterministic and free. **If a test needs the network, it belongs in `test:integration`.**
- **Never assert on model prose.** Assert on tool-call sequences, event types and ordering, and filesystem effects.
- Fakes live in `packages/*/src/testing/` and are exported. They are production-quality code — every downstream package's tests depend on them.

## Repo-specific gotchas

Learned the hard way; don't rediscover them.

- **Packages resolve to TypeScript source**, via `"exports": { "./*": "./src/*.ts" }` in each `package.json`. Import as `@nap/shared/version`, not `@nap/shared`. There is no build step for tests or typecheck, and no root barrel to import from — which is what enforces the no-barrel-files rule.
- **Relative imports need an explicit `.ts` extension** (`allowImportingTsExtensions` is on in `tsconfig.base.json`). Safe because `tsc` never emits — Vite and Bun do the transpiling.
- **Adding a cross-package dependency requires re-running `bun install`** to create the workspace symlink, or the import resolves at typecheck but fails at runtime.
- **For any M2 work, read the `claude-api` skill first — don't answer from memory.** M2 hardcodes `claude-opus-5`, `effort: "xhigh"`, `display: "summarized"`, `stop_reason: "refusal"` handling, disabled SDK built-ins and in-process MCP tools. Every one of those is an API detail that changes, and M2 is the milestone where a stale recollection costs the most.
- **A `PostToolUse` hook reformats each file after you write it.** So an `Edit` whose `old_string` came from text you wrote earlier in the turn can fail to match — Biome may have reflowed it. Re-read the file rather than guessing at the diff.
- **Turbo runs tasks in strict env mode**, so an exported variable does *not* reach a task unless it is listed in that task's `passThroughEnv` in `turbo.json`. `DATABASE_URL=… bun run dev` silently produced a "missing DATABASE_URL" boot failure until `dev` declared it. The normal path is a `.env` file, which Bun auto-loads from the app directory.
- **`apps/api` env is validated at boot by a pure `parseEnv(record)`**, not by reading `process.env` at import time. Keep it that way — it is what lets the env tests run without mutating global state, and it keeps boot order independent of import order.
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
