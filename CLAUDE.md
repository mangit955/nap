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
bun run dev               # turbo dev — api on :3001, web on :3000; copy apps/api/.env.example to .env first
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
- **Read a library's installed types before writing against it** — `node_modules/<pkg>/**/*.d.ts`, not memory. Every version surprise in this repo so far was found this way and none would have been caught by recall: zod 4 moved to `z.iso.datetime()` and a two-arg `z.record()`, drizzle 0.45's table-extras callback returns an *array*, pino takes `(options, stream)`, Next exports a `Viewport` type. Checking costs one `grep`; being wrong costs a debugging session.
- **An env key becomes required in the task that first reads it.** `apps/api/src/env.ts` validates only what the API uses today; `apps/api/.env.example` lists the rest commented out. A boot check that fails on credentials nothing uses teaches people to paste dummy values, which is worse than no check.
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

Learned the hard way; don't rediscover them.

- **Packages resolve to TypeScript source**, via `"exports": { "./*": "./src/*.ts" }` in each `package.json`. Import as `@nap/shared/version`, not `@nap/shared`. There is no build step for tests or typecheck, and no root barrel to import from — which is what enforces the no-barrel-files rule.
- **Relative imports need an explicit `.ts` extension** (`allowImportingTsExtensions` is on in `tsconfig.base.json`). Safe because `tsc` never emits — Vite and Bun do the transpiling.
- **Adding a cross-package dependency requires re-running `bun install`** to create the workspace symlink, or the import resolves at typecheck but fails at runtime.
- **`bun run <script>` resolves against the nearest `package.json`, and a shell's cwd persists between commands.** A stray `cd` is enough for `bun run test` to quietly run a single package's scripts, or for `bun add` to install into the wrong workspace — both of which have happened. Run from the repo root unless you specifically mean not to.
- **Anything the root `vitest.config.ts` imports must be a *root* devDependency.** `@vitejs/plugin-react` installed into `apps/web` fails at config load with `ERR_MODULE_NOT_FOUND`, because the config resolves from the root.
- **`Omit` over a discriminated union silently collapses it.** `Omit<NapEvent, "seq">` flattens the eleven members into one object whose `type` and `payload` are independent unions — so `tool.call` would accept a `turn.failed` payload, and adding `seq` back no longer yields a `NapEvent`. Distribution needs a naked type parameter: `T extends unknown ? Omit<T, K> : never`. `packages/shared/src/ports/event-store.ts` exports a `DistributiveOmit` doing this — use it rather than writing a second copy. The type tests caught this; nothing at runtime would have.
- **`created_at` is `timestamptz`, so the driver returns a `Date` — but the event contract types `createdAt` as an ISO string.** Whatever implements `EventStore` maps it with `.toISOString()`. `packages/db/src/schema.ts` explains why the column stays a real timestamp.
- **Read the `claude-api` skill once per milestone that touches the Anthropic API, and pin what you learn here as a gotcha.** Never answer from memory — the model id, `effort: "xhigh"`, `display: "summarized"`, `stop_reason: "refusal"` handling and tool-call mechanics are all details that change, and the intelligence plane is where a stale recollection costs most. But do not re-read it per task either: the skill inlines its whole documentation set, most of which (Managed Agents, Bedrock, Vertex, model migration) can never apply here, and it dominated one session's context to answer a single question about tool-definition shape. The first task of a milestone reads it and writes the answers down; every task after that reads *this file*. A written record is not recollection — the `usage.input_tokens`, `signal`-argument and `maxRetries` notes below are exactly that, captured once and load-bearing ever since.
- **A `PostToolUse` hook reformats each file after you write it.** So an `Edit` whose `old_string` came from text you wrote earlier in the turn can fail to match — Biome may have reflowed it. Re-read the file rather than guessing at the diff.
- **`next dev` writes `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` itself**, and re-creates them if deleted. They are committed so the tree stays clean. The generated note is worth heeding: Next 16 differs from what most training data assumes, and `apps/web/node_modules/next/dist/docs/` is the version-accurate reference.
- **Turbo runs tasks in strict env mode**, so an exported variable does *not* reach a task unless it is listed in that task's `passThroughEnv` in `turbo.json`. `DATABASE_URL=… bun run dev` silently produced a "missing DATABASE_URL" boot failure until `dev` declared it. The normal path is a `.env` file, which Bun auto-loads from the app directory.
- **`apps/api` env is validated at boot by a pure `parseEnv(record)`**, not by reading `process.env` at import time. Keep it that way — it is what lets the env tests run without mutating global state, and it keeps boot order independent of import order.
- **Bun installs and dispatches; Node executes.** `bun run` honours a binary's shebang, so Vitest and Next.js run under Node. Only `apps/api` and our own entrypoints use the Bun runtime. This is deliberate — see "Bun/Node split" in `docs/PLAN.md`.
- **E2B's contract differs from ours in three places**, all resolved in `packages/sandbox/src/e2b-sandbox-manager.ts` and all found by running the conformance suite for real. `commands.run` **throws `CommandExitError` on any non-zero exit** — ours treats a failing command as data, so the adapter converts it; without that, a failing build reaches the agent as an infrastructure fault. `AuthenticationError` extends `Error`, **not** `SandboxError`, so an `instanceof SandboxError` catch-all silently misses a bad API key. And E2B validates the *shape* of a sandbox id before looking it up: an arbitrary string is `400: Invalid sandbox ID`, not a 404, which is why the conformance harness supplies `unknownSandboxId()` rather than inventing one.
- **A `Proxy` cannot reach a class's `#private` fields.** The receiver becomes the proxy, so any method touching `#state` throws `TypeError: Receiver must be an instance of class`. Wrapping an object that has private state means spelling out the delegated methods.
- **The integration suite loads `apps/api/.env` itself**, via `test/integration-setup.ts`. Bun auto-loads that file for the API, but Vitest runs under Node, which does not — so without it every integration run would need the variables exported by hand.
- **`process.loadEnvFile` is a Node API that Bun does not implement.** It is fine in `test/integration-setup.ts` (Vitest → Node) and throws in anything run by `bun run`. Scripts under `bun run` parse the file themselves.
- **The sandbox project template is built by hand** — `bun run template:build` in `packages/sandbox`, never by a test. It publishes a named, billable artifact that later sandbox creation depends on. `packages/sandbox/template/` is a separate app with its own React/Vite toolchain: it is outside our tsconfigs on purpose, so the only thing that type-checks it is a `tsc` run *inside* a sandbox, in the integration suite. That check earned itself immediately by catching two broken imports.
- **Anything from a model that reaches a command line must be shell-quoted.** `shellQuote` lives in `packages/shared/src/shell.ts` because two unrelated callers need it — git commit messages and the `search_files` grep pattern — and the attacker is whatever the user typed into a chat box. The one deliberate exception is `run_command`'s command itself: quoting it would turn a pipeline into a filename, so what may run is the safety guard's question instead — `packages/agent/src/safety/commands.ts`. Quoting is verified by round-tripping hostile inputs through a real `sh` in the unit tests — asserting on the *shape* of the quoted string does not distinguish safe from unsafe, because the payload text is present either way.
- **A bound port is not a loadable preview.** E2B's `waitForPort` readiness check fires when something binds the port *inside* the sandbox, but users reach it through a public proxy that becomes ready separately, and its 502s during that gap are "not yet" rather than "broken". `waitForPreview` on the `SandboxManager` port polls the real URL for a 200; anything showing a preview should wait on that, not on `getPreviewUrl`, which only composes an address and promises nothing.
- **In the E2B base image, `/usr/local/bin` precedes `/usr/bin` on PATH.** Installing a newer Node from NodeSource lands in `/usr/bin` and changes nothing — `node --version` still reports the image's 20.9, silently, until something refuses to start. The template build relinks the binaries; anything else installing tooling into that image needs to do the same.
- **`usage.input_tokens` from the Anthropic API is the *uncached remainder*, not the input total.** Cache writes and cache reads are billed and reported in their own fields (`cache_creation_input_tokens`, `cache_read_input_tokens`), so a heavily-cached call can report a few hundred input tokens against a prompt of tens of thousands. `toTokenUsage` in `packages/agent/src/claude-provider.ts` sums all three, because a budget built on the unsummed number would be wrong by most of the prompt. There is a test pinning this.
- **The Anthropic SDK takes `signal` in its *second* argument, not the request body** — `messages.stream(body, { signal })`. And under `exactOptionalPropertyTypes` a narrow client type must say `signal?: AbortSignal | undefined`, since "absent" and "present but undefined" are different types and no-signal is the normal case.
- **The SDK's own retries are invisible to a test.** `new Anthropic()` retries twice by default, so a provider that also retries makes three attempts look like nine and "gives up after N" unprovable. `ClaudeProvider` constructs the client with `maxRetries: 0` and owns the loop.
- **All of a turn's `tool_result` blocks go back in one user message.** Parallel tool use is on by default: a single assistant message can carry several `tool_use` blocks. Answering them in separate user messages is accepted by the API and quietly trains the model to stop asking for tools in parallel — the failure is a slower agent, never an error. Execute the batch, then send every result together, including the failures: a failed tool is a `tool_result` with `is_error: true`, never a dropped block. This is the shape `executeTool`'s `ok` field exists to feed.
- **`@anthropic-ai/sdk` and `@anthropic-ai/claude-agent-sdk` are different products.** The first is the Messages API client this repo uses. The second is Claude Code packaged as a library — it owns the agent loop and ships the built-in `Read`/`Write`/`Edit`/`Bash`. We want neither of those: the loop has to emit typed events and be cancellable, and the only tools that may exist are the six that proxy to `SandboxManager`. The plan originally specified the second one — see the amendment note in `docs/PLAN.md` §0 for why it did not survive contact with the testing strategy.
- **A tool call and its result travel together or not at all.** The API rejects a `tool_use` block with no answering `tool_result`, and vice versa — so anything shortening a conversation to fit a budget cannot simply delete the biggest block it finds. `NapContextEngine` reclaims tool output by replacing the *content* while keeping the block and its `toolCallId`, and drops history a whole turn at a time so both halves leave together. Deleting a result to save tokens does not produce a smaller request, it produces a 400. There is a test asserting no orphan in either direction, at five budgets.
- **The system prompt has no "verify your work" instruction, and that is the design.** `claude-opus-5` already checks its own work; telling it to do so again produces redundant tool calls and long reports *about* the checking rather than fewer mistakes, and removing such instructions costs no capability. The omission reads as an oversight, so `system-prompt.test.ts` fails on a phrase list plus any `/\bverif/i` match. If you are about to "improve" the prompt by adding a verification step, that is the thing this is here to stop.
- **The prompt's facts must match `packages/sandbox/template/` exactly.** The first draft claimed a `public/` directory the template does not have and said nothing about Tailwind v4 having no config file. Neither produces a confused agent — both produce a confident one, writing files nothing serves. Tests pin both.
- **The context token budget is a cost limit, not the model's context window.** `claude-opus-5` accepts 1M tokens; `DEFAULT_BUDGET_TOKENS` is 120k, and the gap is deliberate — a bigger window is not a reason to raise it. Token counts are a local estimate (~4 chars/token) because the exact number is a network call per string, which would make the budget untestable and every turn a round trip.
- **Iterate on `claude-sonnet-5`, demo on `claude-opus-5` — and never swap *vendor* to save money.** Most turns during development are spent debugging the loop (event ordering, tool sequencing, did the commit land), which needs a model that returns well-formed tool calls rather than a good one. Sonnet is materially cheaper and changes nothing structural: same `@anthropic-ai/sdk`, same `tool_use`/`tool_result` blocks, same streaming events, same `stop_reason: "refusal"`. A second vendor is a different proposition and was rejected — the failures are all *silent*. `toTokenUsage` sums `input_tokens` with both cache fields because Anthropic reports the uncached remainder; OpenAI's `prompt_tokens` already includes cached tokens, so the same code double-counts and `TurnBudget` kills turns early with no error. Anthropic answers N tool calls in **one** user message; OpenAI wants N `role: "tool"` messages, inverting the rule `agent-service.test.ts` pins. And the system prompt's missing verification instruction is tuned to *this* model. `packages/shared/src/ports/llm-provider.ts` is the seam that keeps a vendor additive in v2 — it is not a licence to swap one in now.
- **The command guard matches the *head of a shell segment*, never a substring.** `inspectCommand` splits on `;`/`&&`/`||`/`|`, pulls `$(…)` and backticks out as commands of their own, follows `sh -c`, and strips `sudo`/`env`/`VAR=x` — then matches only the resulting command name. Searching the raw string for "curl" instead is shorter, blocks `echo "run curl to fetch it"`, and there is an allow-list row that fails when someone tries it. Both tables are the test: `packages/agent/src/safety/commands.test.ts` pins ~28 blocked forms *and the rule each is blocked by*, plus 16 ordinary ones that must run. The guard is not the isolation boundary — the E2B VM is — it exists so a prompt-injected model does not get the whole VM.

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
