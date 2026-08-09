# Nap v1 — Detailed TDD Build Plan

> **This plan is executed across many sessions.** Read § 1 (Session Protocol) first, every session, before doing anything else.
>
> Canonical location: `docs/PLAN.md` in the Nap repo. This file is the source of truth for what v1 is and how it gets built. Task *status* lives in `PROGRESS.md` (created in M0-2), not here.

---

## 0. Context

Nap is a Lovable-style AI app builder: user describes an app in chat → an agent writes code into an isolated sandbox → a live preview updates as it works. The reference architecture has five planes (Presentation, Intelligence, Control, Execution, Infrastructure). **v2** adds long-term memory and multi-agent; **v1** is a thin vertical slice through all five planes, with every v2 seam present as an interface.

### Locked decisions

| Decision | Choice |
|---|---|
| v1 scope | Thin vertical slice through all planes |
| Execution plane | E2B managed sandboxes, behind `SandboxManager` |
| Stack | TypeScript end-to-end (Next.js + Hono) |
| Package manager / runtime | **Bun** — `bun install`, `bun run`, and Bun as the `apps/api` runtime. Vitest is retained as the test runner; it and Next.js still execute under Node via their shebangs. See "Bun/Node split" below. |
| Generated app stack | React + Vite + Tailwind, frontend-only |
| UI panels | Chat + Preview + read-only file tree |
| Agent autonomy | Autonomous, every tool call streamed |
| Persistence | Git-backed workspace, snapshotted to R2 |
| `LLMProvider` scope | Model config + policy only, **not** a cross-vendor swap |
| Progress tracking | In-repo `PROGRESS.md` + `CLAUDE.md` |
| Test strategy | Fakes by default; tagged integration tests at milestone boundaries |
| Git | Branch per milestone, one commit per completed task |

### Component ownership (memorize this — it prevents 80% of design drift)

| Component | Owns | Never does |
|---|---|---|
| `Runtime` | Turn lifecycle: acquire sandbox → build context → run agent → persist → publish → git commit → snapshot. Budgets, cancellation, failure recovery. | Prompt content, model params, tool implementations |
| `ContextEngine` | Assembling context: system prompt, stack contract, file-tree digest, conversation window, retrieved memories. Context token budget + truncation order. | Calling the model, deciding when a turn ends |
| `AgentService` | Driving the model loop for one turn: stream tokens, execute sandbox-proxy tools, emit typed events. | Persistence, git, sandbox lifecycle, prompt assembly |
| `LLMProvider` | Model id, effort, thinking config, refusal/fallback policy, retries, per-turn usage accounting. | Vendor abstraction |
| `MemoryProvider` | `retrieve()` / `write()`. v1 = `NoopMemoryProvider`. | Anything in v1 — but call sites are real |
| `SandboxManager` | Sandbox lifecycle, filesystem, exec, preview URL. | Knowing what an agent or turn is |
| `EventStore` / `EventBus` | Durable append, then fanout — in that order. | Business logic |

### Bun/Node split (decided at M0-1)

Bun is the package manager and script runner. Vitest stays the test runner, because `bun test` has no named projects (M0-1 needs two suites), no `--changed` (the pre-commit hook needs it), different `mock.module` hoisting from `vi.mock` (M1-2 and M2-1 need it), and no `*.test-d.ts` typecheck mode (M0-4 needs it).

`bun run <script>` honours a binary's shebang unless `--bun` is passed, so Vitest and Next.js transparently run under **Node** while installs, script dispatch, and our own TS entrypoints run under **Bun**. That keeps the dependency most likely to cost a session — testcontainers (M0-5) — on Node, while `apps/api` still gets Bun's native TS execution and `Bun.serve`.

> ⚠️ **Always `bun run test`, never `bun test`.** `test` is a Bun built-in command and shadows the package.json script — bare `bun test` runs Bun's own runner over our Vitest files and reports nonsense.

**Dependency direction (enforced):** `runtime` → {`context`, `agent`, `sandbox`, `db`} → `shared`. `agent` imports the `SandboxManager` *interface*, never the E2B adapter.

**Key decision — where tools execute.** A batteries-included agent harness (the Claude Agent SDK, and anything like it) ships built-in `Read`/`Write`/`Edit`/`Bash` that act on the harness process's filesystem — which is our API server, not the sandbox. So we do not use one. `AgentService` drives the Messages API through the `LLMProvider` port and owns its own loop, and **the only tools that exist are the six that proxy every operation through `SandboxManager`** — a stronger guarantee than disabling built-ins, because there is no toggle to get wrong. Keeps the API key out of user compute, gives one chokepoint for events and diffs, and makes E2B→K8s a one-package change.

> Amended after M2-1. The original plan put `AgentService` on the Claude Agent SDK with its built-ins disabled. That SDK owns the agent loop, which leaves no seam for `ScriptedLLMProvider` — and M2-7's own tests, plus the §3 testing strategy, are built on that seam. M2-1 resolved it in favour of the port; these paragraphs were reconciled two tasks later.

### Architecture

```
Browser (Next.js)                         ← Presentation Plane
   │ HTTPS + WebSocket
API server (Hono + ws)                    ← API Gateway/BFF + Session Service + Streaming Hub
   │
   └── Runtime  (turn orchestration)      ← Intelligence Plane
         ├── ContextEngine ──► MemoryProvider (no-op in v1)
         ├── AgentService  ──► LLMProvider
         ├── SandboxManager ──────────────► E2B sandbox   ← Execution / Control Plane
         ├── EventStore (Postgres)                          /workspace (git repo)
         └── EventBus (in-process)                          vite dev :5173 → preview URL
```

---

## 1. Session Protocol

**At the start of every session:**
1. `cd` to the repo, run `git status` and `git log --oneline -10`.
2. Read `CLAUDE.md` (conventions) and `PROGRESS.md` (task states).
3. Run `bun run test` — confirm green before starting new work. If red, fixing that is the session's first task.
4. Pick the next task with status `TODO` whose dependencies are all `DONE`.
5. Set it to `IN_PROGRESS` in `PROGRESS.md` and commit that single-line change.

**At the end of every session (or when a task completes):**
1. Run `bun run test` and `bun run typecheck` — both must pass.
2. Mark the task `DONE` in `PROGRESS.md`, with a one-line note on anything surprising.
3. Commit: `feat(<scope>): <task id> <summary>` including tests.
4. If the session is ending mid-task: commit WIP on the milestone branch with `wip(<scope>): <task id> — <what's left>` and leave the task `IN_PROGRESS` with a "next step" note in `PROGRESS.md`.

**Never** leave uncommitted work at the end of a session. A future session cannot recover context that only exists in a dirty working tree.

### `PROGRESS.md` format

```md
# Nap v1 Progress

Current milestone: M1 — Execution Plane   (branch: feat/m1-execution-plane)

| ID | Task | Status | Notes |
|----|------|--------|-------|
| M0-1 | Workspace scaffold | DONE | |
| M1-1 | SandboxManager interface | IN_PROGRESS | next: add exec() streaming signature |
| M1-2 | E2B adapter | TODO | |
```

Statuses: `TODO` · `IN_PROGRESS` · `DONE` · `BLOCKED` (with reason) · `SKIPPED` (with reason).

---

## 2. Conventions (to be copied into `CLAUDE.md` at M0-2)

- **TypeScript strict**, no `any`, no non-null `!` except in tests.
- **Zod at every boundary**: env vars, HTTP bodies, WebSocket frames, persisted event payloads. Types are inferred from schemas, never hand-written alongside them.
- **Errors**: typed result objects for expected failures (sandbox unavailable, turn budget exceeded); thrown exceptions only for programmer error.
- **No barrel files** re-exporting across packages — import from the specific module.
- **Every exported function gets a test** before it gets an implementation.
- Formatting/linting: Biome. Pre-commit hook runs `biome check` + `tsc --noEmit` + `vitest run --changed`.

---

## 3. Test Strategy

**Two suites, sharply separated.**

| Suite | Command | Runs against | When |
|---|---|---|---|
| Unit/integration (default) | `bun run test` | Fakes only — `InMemorySandboxManager`, `ScriptedLLMProvider`, in-memory `EventStore`, Postgres via testcontainer | Every save, every commit, CI |
| External | `bun run test:integration` | Real E2B + real Anthropic API | Manually, at each milestone boundary |

**Rules that keep TDD honest here:**
- Unit tests must be deterministic and free. If a test needs a network call, it belongs in `test:integration`.
- **Never assert on model prose.** Assert on tool call sequences, event types and ordering, and file-system effects. `ScriptedLLMProvider` returns a pre-baked sequence of tool calls + text so agent-loop tests are fully deterministic.
- Fakes live in `packages/*/src/testing/` and are exported — they're production-quality code, used by every downstream package's tests.
- Each task below lists its tests **first**. Write them, watch them fail, then implement.

**The three fakes to build early (they unblock everything):**
- `InMemorySandboxManager` — a `Map<path, content>` filesystem, scriptable `exec` responses, fake preview URL.
- `ScriptedLLMProvider` — takes a list of turns; each turn is a list of `{ type: "text" | "tool_use", ... }` to emit.
- `InMemoryEventStore` / `InMemoryEventBus` — array-backed, with an assertion helper `expectEventSequence([...])`.

---

## 4. Task List

Format: **`ID` — Title** · deps · what to build · **Tests (write first)** · **Done when**.

---

### M0 — Scaffold & Contracts  `branch: feat/m0-scaffold`

**M0-1 — Workspace scaffold** · deps: none
Bun workspaces + Turborepo. Packages: `shared`, `db`, `sandbox`, `agent`, `context`, `runtime`. Apps: `web`, `api`. TypeScript strict, Biome, Vitest with two projects (`unit`, `integration`). Root scripts: `dev`, `build`, `test`, `test:integration`, `typecheck`, `lint`.
**Tests:** a trivial passing test in each package proving the runner resolves workspace imports (`shared` importable from `runtime`).
**Done when:** `bun run test`, `bun run typecheck`, `bun run lint` all pass on an empty repo.

**M0-2 — `CLAUDE.md` + `PROGRESS.md`** · deps: M0-1
Write conventions (§2), session protocol (§1), and the full task table from this plan seeded as `TODO`.
**Tests:** none (docs).
**Done when:** both files committed; a cold read of them explains how to resume.

**M0-3 — Event schemas** · deps: M0-1
`packages/shared/src/events.ts`: Zod discriminated union on `type` for all 11 event types — `user.message`, `agent.thinking`, `agent.message`, `tool.call`, `tool.result`, `file.changed`, `command.output`, `preview.ready`, `turn.started`, `turn.completed`, `turn.failed`. Each carries `sessionId`, `seq`, `turnId`, `createdAt`.
**Tests:** for every event type — a valid fixture parses; a malformed fixture rejects with a useful issue path; the union discriminates to the right member; round-trip `parse(JSON.parse(JSON.stringify(x)))` is identity.
**Done when:** 11 event types × 4 assertions green.

**M0-4 — Interface declarations** · deps: M0-3
`packages/shared/src/ports/`: type-only declarations for `SandboxManager`, `AgentService`, `LLMProvider`, `ContextEngine`, `MemoryProvider`, `Runtime`, `EventStore`, `EventBus`. **Write all of them now**, including ones with trivial v1 impls — this file is what keeps v2 additive.
**Tests:** compile-time only — a `types.test-d.ts` using `expectTypeOf` asserting each interface's shape and that a stub satisfies it.
**Done when:** `tsc --noEmit` passes and type tests assert each contract.

**M0-5 — DB schema + migrations** · deps: M0-1
Drizzle: `users`, `projects`, `sessions`, `events`, `snapshots` (per §5). Unique index on `(session_id, seq)`. Local Postgres via `infra/docker-compose.yml`; testcontainer for tests.
**Tests:** migration applies to a clean DB; insert/select round-trip per table; the `(session_id, seq)` unique constraint rejects a duplicate.
**Done when:** migrations apply and constraint tests pass.

**M0-6 — API skeleton + env validation** · deps: M0-1
Hono server, `/health`, pino logger with `sessionId`/`turnId` in context, Zod-validated env that fails fast at boot listing every missing key.
**Tests:** `/health` returns 200 with a version field; env parser throws listing all missing vars (not just the first); logger emits JSON with expected fields.
**Done when:** `bun run dev` starts the API; a missing env var produces a clear boot failure.

**M0-7 — Web skeleton** · deps: M0-1
Next.js 16 App Router, three-pane layout shell (chat | preview | file tree), Tailwind v4, placeholder content.
**Tests:** render test asserting all three panes mount.
**Done when:** `bun run dev` serves the shell.

---

### M1 — Execution Plane  `branch: feat/m1-execution-plane`

**M1-1 — `SandboxManager` interface + `InMemorySandboxManager`** · deps: M0-4
Interface: `create(projectId)`, `resume(sandboxId)`, `destroy(id)`, `writeFile`, `readFile`, `listFiles`, `exec(cmd, onOutput)`, `getPreviewUrl(port)`. Then the in-memory fake — **this is the most reused test double in the codebase, build it properly.**
**Tests (against the fake, and later reused verbatim against E2B):** write→read round-trip; read of a missing file returns a typed not-found, doesn't throw; `listFiles` returns a correct tree with nesting; `exec` streams output chunks in order then resolves with an exit code; a non-zero exit is reported, not thrown; `destroy` makes subsequent ops fail with a typed error.
**Done when:** a shared conformance test suite exists that *any* `SandboxManager` implementation must pass, and the fake passes it.

**M1-2 — E2B adapter** · deps: M1-1
`E2BSandboxManager` against the E2B SDK.
**Tests:** `test:integration` — run the M1-1 conformance suite against a real sandbox. Unit-level: error mapping (E2B errors → our typed errors) with a stubbed SDK client.
**Done when:** the conformance suite passes against real E2B; teardown leaves no orphan sandboxes.

**M1-3 — Project template** · deps: M1-2
Vite + React + TS + Tailwind starter, `node_modules` baked into a custom E2B template so cold start skips install. `git init` + initial commit at scaffold.
**Tests:** `test:integration` — create sandbox from template; assert expected files exist, `node_modules` is present, and `git log` has exactly one commit.
**Done when:** cold start to ready is measured and recorded in `PROGRESS.md`.

**M1-4 — Dev server boot + preview URL** · deps: M1-3
Start `vite dev --host` on create, expose 5173, return the public URL. Wait-for-ready with a timeout rather than a fixed sleep.
**Tests:** `test:integration` — after create, the preview URL returns 200 with the template's HTML within N seconds; a boot failure surfaces a typed error, not a hang.
**Done when:** the URL renders the template app in a real browser.

**M1-5 — Git helpers** · deps: M1-1
`commitAll(sandbox, message)`, `currentSha(sandbox)`, `bundle(sandbox)`, `restoreBundle(sandbox, bytes)` — all via `exec`.
**Tests (against the fake with scripted `exec`):** commit invokes the expected git commands in order; commit with no changes is a no-op, not an error; `currentSha` parses output; bundle/restore round-trips (integration).
**Done when:** unit tests green against the fake; round-trip verified in integration.

---

### M2 — Intelligence Plane  `branch: feat/m2-intelligence`

**M2-1 — `LLMProvider` + `ScriptedLLMProvider`** · deps: M0-4
`ClaudeProvider`: model `claude-opus-5`, `effort: "xhigh"`, adaptive thinking with `display: "summarized"`, streaming, refusal/fallback policy, per-turn usage accumulator. Then `ScriptedLLMProvider` — the fake that makes every agent test deterministic.
**Tests:** usage accumulates across multiple calls in a turn and resets per turn; a `stop_reason: "refusal"` response produces a typed refusal result and never reads `content[0]`; retry policy retries a 429 and gives up after N; `ScriptedLLMProvider` emits its scripted sequence exactly.
**Done when:** unit tests green; one `test:integration` proves a real streamed call works end to end.

**M2-2 — `MemoryProvider` + `NoopMemoryProvider`** · deps: M0-4
Interface `retrieve(sessionId, query) → Memory[]`, `write(sessionId, events) → void`. Ship the no-op.
**Tests:** `retrieve` returns `[]`; `write` is a no-op and never throws; a consumer given the no-op behaves identically to one given no provider at all.
**Done when:** the seam exists and is proven inert.

**M2-3 — `ContextEngine`** · deps: M2-2, M0-3
`build({ session, sandbox, memory }) → { systemPrompt, messages }`. Assembles: generated-app stack contract, file-tree digest, recent conversation window, `memory.retrieve()` results. Owns a context token budget with an explicit truncation order.
**Tests:** the stack contract is present in **every** output, including under the smallest possible budget; truncation drops oldest tool results first and never the stack contract; conversation window respects its turn limit; memory results are interpolated when present and cleanly absent with the no-op; total estimated tokens never exceed the budget.
**Done when:** budget/truncation tests green — this is the component most likely to silently degrade quality, so its tests matter more than its code.

**M2-4 — System prompt** · deps: M2-3
Stack contract (React/Vite/Tailwind, file conventions, no server code), **conciseness** and **scope-discipline** instructions (`claude-opus-5` writes long and widens scope without them), and **no self-verification instructions** (they cause over-verification on this model).
**Tests:** snapshot test on the assembled prompt so unintended edits are caught; assertions that required sections are present.
**Done when:** snapshot committed and reviewed by a human once.

**M2-5 — Sandbox-proxy tools** · deps: M1-1, M0-3
`read_file`, `write_file`, `edit_file`, `list_files`, `search_files`, `run_command` — each calling `SandboxManager` and emitting `tool.call` / `tool.result`; writes additionally emit `file.changed` with a diff.
**Tests (against `InMemorySandboxManager`):** each tool's happy path emits call+result in order; each tool's failure emits a result marked as error and does **not** throw; `write_file` emits a `file.changed` with a correct unified diff; `edit_file` on a non-matching string fails cleanly with a useful message; `run_command` streams `command.output` chunks in order.
**Done when:** all six tools tested against the fake, zero real network calls.

**M2-6 — Safety hooks** · deps: M2-5
Block `rm -rf /` and similar, package installs outside the project, and network egress commands. Per-turn step and token budget.
**Tests:** a table-driven test of ~15 dangerous command strings, each asserted blocked; ~10 legitimate commands asserted allowed (guard against over-blocking); exceeding the step budget terminates the turn with `turn.failed` carrying a budget reason; same for token budget.
**Done when:** both the block list *and* the allow list are green — an over-eager guard is as bad as a missing one.

**M2-7 — `AgentService`** · deps: M2-1, M2-5, M2-6
`runTurn({ context, sandbox, onEvent })` driving the model loop through the `LLMProvider` port, with the six proxy tools declared as the request's entire tool set — see §0's "where tools execute". Each round trip: `complete()` → execute every returned tool call → feed **all** the results back in one user message → repeat until the model stops asking for tools.
**Tests (with `ScriptedLLMProvider` + `InMemorySandboxManager`):** a scripted single-tool turn emits `turn.started` → `tool.call` → `tool.result` → `agent.message` → `turn.completed` in exact order; a multi-tool turn executes tools in order; a tool error is fed back to the model rather than aborting; a refusal produces `turn.failed` with a refusal reason; cancellation mid-turn stops tool execution and emits `turn.failed`.
**Done when:** the event-ordering tests pass deterministically 10 runs in a row.

**M2-8 — `Runtime`** · deps: M2-7, M2-3, M1-5, M0-5
`SingleAgentRuntime.runTurn(sessionId, message)`: resume-or-create sandbox → `ContextEngine.build` → `AgentService.runTurn` → per event `EventStore.append` **then** `EventBus.publish` → on success `git commit` → on failure emit `turn.failed`, leave workspace at last good commit.
**Tests (all fakes):** append happens before publish for every event (assert via a recording spy on ordering); `seq` increments monotonically with no gaps; a successful turn produces exactly one git commit; a **failed** turn produces **zero** commits; a sandbox-create failure emits `turn.failed` and never invokes the agent; concurrent turns on the same session are serialized, not interleaved.
**Done when:** all six green. The "no commit on failure" and "append before publish" tests are the two most valuable in the codebase — do not skip them.

> Amended during M2-8. A turn request carries only a session id, so "resume-or-create" needed a source for the session's project and its current sandbox: `SessionStore` (`packages/shared/src/ports/session-store.ts`), two methods, with the Postgres implementation deferred to M4-4. A sandbox that is recorded but cannot be resumed **fails the turn** rather than creating a fresh one — until M4-2 can restore a snapshot, starting over means silently handing the user an empty template. `user.message` is appended by the runtime, before `turn.started`.

**M2-9 — CLI harness** · deps: M2-8
A `bun run harness "<prompt>"` script running a real turn against real E2B + real Claude, printing the event stream.
**Tests:** manual. This is the M2 acceptance gate.
**Done when:** `bun run harness "add a dark mode toggle"` changes a real file, prints ordered events, and leaves a git commit.

> Amended during M2-9. The harness runs on a scripted model and an in-memory sandbox **by default** and takes `--real` to use the real ones, because the API budget is near-zero and everything except the request shape can be proven for free. A real run defaults to `claude-sonnet-5` at `medium` effort with a 12-step, 40k-token ceiling — hence `ClaudeProvider` gaining `model`/`effort`/`maxTokens`. The "Done when" above describes the `--real` run specifically, and is deliberately outstanding.

---

### M3 — Presentation & Streaming  `branch: feat/m3-presentation`

**M3-1 — `EventStore` (Postgres) + `EventBus` (in-process)** · deps: M0-5
`append(event) → seq`, `readFrom(sessionId, seq)`, plus EventEmitter-backed bus.
**Tests (testcontainer Postgres):** `append` assigns monotonic `seq` per session; concurrent appends produce no duplicate `seq` (hammer with 100 parallel); `readFrom` returns exactly events after the given seq, ordered; bus delivers to all subscribers; unsubscribe stops delivery.
**Done when:** the concurrency test passes reliably.

**M3-2 — WebSocket endpoint** · deps: M3-1
`/ws?sessionId=…&seq=N`: replay from `seq`, then subscribe and tail. Heartbeat.
**Tests:** write 10 events, connect with `seq=5`, assert exactly 5 replayed then live tail with no duplicates and no gap; a client connecting during an active turn receives the in-flight remainder; heartbeat timeout closes a dead connection; malformed frames are rejected without killing the socket.
**Done when:** the replay-then-tail test is green — this is the correctness heart of the streaming layer.

> Amended during M3-2. The heartbeat is an application-level `ping`/`pong` frame rather than a WebSocket control frame, because browser JavaScript can neither send a control-frame pong nor observe a ping — a control-frame heartbeat would be invisible to the only client this has. Frames in both directions are a Zod union in `packages/shared/src/ws-protocol.ts`, since M3-3 parses the same shapes. The route handler cannot run under Vitest (`upgradeWebSocket` requires a live `Bun.serve`), so `createApp` takes the adapter as a dependency, the connection logic sits behind a two-method socket type, and the Bun path has its own free gate: `bun run ws:smoke`. Boot was wired to Postgres in this task rather than deferred — `/ws` against an in-memory store would forget a transcript on every restart.

**M3-3 — Client WS hook + reconnect** · deps: M3-2
`useEventStream(sessionId)` with backoff reconnect, tracking last `seq`.
**Tests:** with a mock socket — reconnect resumes from the correct `seq`; backoff increases then caps; events dedupe by `(sessionId, seq)`; unmount closes cleanly.
**Done when:** reconnect tests green.

> Amended during M3-3. Backoff is deterministic — 500ms doubling to a 10s cap, reset on `open` — with no jitter: jitter exists to stop a crowd retrying in lockstep, and a session here is one browser tab. The hook takes a socket factory so the curve is assertable in milliseconds; nothing in the `web` vitest project can open a real socket anyway, since Node's `WebSocket` and jsdom's `EventTarget` are incompatible. The header's connection indicator was wired in this task rather than left to M3-4, so that `next build` actually reaches the hook and proves the `transpilePackages` wiring `@nap/shared` needs; it reads a temporary `NEXT_PUBLIC_DEV_SESSION_ID` that M3-7 removes.

**M3-4 — Chat pane** · deps: M3-3, M0-3
Renders the event stream: user/agent messages, collapsible tool calls, streamed command output, file-change chips, thinking indicator.
**Tests:** render tests per event type; a `tool.call` without its `tool.result` renders as in-progress; streamed text appends rather than replaces; long output is virtualized/truncated with expand.
**Done when:** every one of the 11 event types has a defined visual treatment and a test.

> Amended during M3-4. The transcript is an activity rail rather than chat bubbles: one hairline that opens at `turn.started` and closes at `turn.completed`/`turn.failed`, with prose in sans and everything machine-authored in mono. Long output is truncated with expand rather than virtualized — a clamped block is bounded, and v1 shows one session. Folding events into items is a pure function (`apps/web/src/chat/transcript.ts`) so the interesting cases — interleaved tool calls, a stream still arriving, a result whose call this client never received — are tested without rendering. `agent.thinking` has a treatment and a test even though nothing emits it yet; that is the M2-7 gap, and this is where it stops being invisible.

**M3-5 — Preview pane** · deps: M1-4
Sandboxed iframe, reload control, loading and error states.
**Tests:** renders the URL when ready; shows loading before `preview.ready`; shows an actionable error on boot failure; `preview.ready` triggers a hard reload.
**Done when:** all four states have tests.

**M3-6 — File tree** · deps: M1-1
Read-only tree from `listFiles`, syntax-highlighted viewer from `readFile`, highlighting files touched this turn.
**Tests:** tree renders nested structure; selecting a file loads content; `file.changed` marks the node; a large file is truncated with a notice.
**Done when:** tests green against the fake sandbox.

**M3-7 — Turn submission wiring** · deps: M3-4, M2-8
Optimistic user message → POST → `Runtime.runTurn` → stream. Disable input during an active turn; expose cancel.
**Tests:** optimistic message appears immediately and reconciles with the server event without duplicating; input disabled while running; cancel emits `turn.failed` and re-enables input; a failed POST rolls back the optimistic message.
**Done when:** the optimistic-reconcile test is green (this is where duplicate-message bugs live).

---

### M4 — Persistence  `branch: feat/m4-persistence`

**M4-1 — Snapshot on teardown** · deps: M1-5, M0-5
`git bundle` → upload to R2 → write a `snapshots` row.
**Tests:** with a fake object store — teardown produces a bundle, an upload, and exactly one row, in that order; an upload failure does **not** destroy the sandbox (data loss guard); the row records the correct git sha.
**Done when:** the upload-failure guard is green.

**M4-2 — Restore on open** · deps: M4-1, M1-3
Create from template → restore bundle → `npm install` if lockfile changed → boot Vite.
**Tests:** restore reproduces the exact file set and git history (integration); a missing/corrupt bundle falls back to a fresh template with a warning event rather than an error page; install is skipped when the lockfile is unchanged.
**Done when:** integration round-trip (build → teardown → restore) is byte-identical on tracked files.

**M4-3 — Idle reaper** · deps: M4-1
Background job: sandboxes idle > N minutes are snapshotted and destroyed.
**Tests (fake clock):** an idle sandbox is reaped after N; activity resets the timer; a sandbox with a turn in flight is never reaped; a snapshot failure defers destruction.
**Done when:** the never-reap-during-turn test is green.

**M4-4 — Project CRUD + list page** · deps: M0-5, M4-2
Create/open/close/delete. Delete removes snapshots from R2.
**Tests:** create seeds a project + first session; delete cascades to sessions, events, and R2 objects; open of an archived project triggers restore; listing is ordered by `updated_at`.
**Done when:** the cascade test proves no orphaned R2 objects.

**M4-5 — Full-cycle integration test** · deps: M4-2, M4-3
One `test:integration` covering create → turn → teardown → restore → second turn.
**Done when:** green end to end.

---

### M5 — Auth & Hardening  `branch: feat/m5-hardening`

**M5-1 — Auth** · deps: M0-5
Better Auth, email + GitHub OAuth, sessions in Postgres.
**Tests:** signup/login/logout round-trip; expired session rejected; OAuth callback creates exactly one user for a repeat login.
**Done when:** auth tests green.

**M5-2 — Authorization on every route** · deps: M5-1, M4-4
Every project/session/WS route authorizes on `user_id`.
**Tests:** **table-driven across every route** — user B gets 403/404 on user A's resources, including the WebSocket upgrade; an unauthenticated request gets 401. A new route added without authorization must fail this test.
**Done when:** the table covers 100% of routes; add a lint/test that enumerates registered routes and fails if any is missing from the table.

**M5-3 — Rate limits & quotas** · deps: M5-1
Per-user turn rate limit; cap on concurrent sandboxes.
**Tests:** exceeding turn rate returns 429 with `retry-after`; the concurrent-sandbox cap blocks creation with a typed error and a clear UI message; limits are per-user, not global.
**Done when:** the per-user isolation test is green.

**M5-4 — Error surfaces** · deps: M3-4, M3-5
Sandbox failure, agent failure, preview failure, rate limit, auth expiry each get a distinct, actionable UI state — no bare spinners.
**Tests:** render test per failure mode asserting a specific message and a recovery action.
**Done when:** five failure modes, five tests, zero generic messages.

**M5-5 — Observability baseline** · deps: M0-6
Every log line carries `userId`/`projectId`/`sessionId`/`turnId`; per-turn usage and duration logged; `/health` checks DB + E2B reachability.
**Tests:** log assertions on required fields; `/health` returns degraded when a dependency is down.
**Done when:** you can grep a `turnId` and reconstruct a full turn from logs alone.

**M5-6 — v1 acceptance run** · deps: all
Execute the E2E script in §6 manually, twice, from a cold start.
**Done when:** all six steps pass and cost/latency per turn is recorded in `PROGRESS.md`.

---

## 5. Data Model

```
users        id, email, name, created_at
projects     id, user_id, name, slug, status, sandbox_id?, snapshot_key?, created_at, updated_at
sessions     id, project_id, title, created_at
events       id, session_id, seq, type, payload (jsonb), created_at   -- unique(session_id, seq)
snapshots    id, project_id, r2_key, git_sha, created_at
```

`events` is load-bearing: chat transcript, agent audit log, WebSocket replay source, and v2's memory substrate — all one table.

---

## 6. v1 Acceptance (manual E2E)

1. `bun run dev`, sign in, create a project — template preview renders within ~10s.
2. "Build a todo list with add, complete, and delete" — file changes stream live; preview shows a working todo list.
3. "Make it dark mode with a purple accent" — incremental edit lands via HMR without a full reload.
4. Toggle devtools offline, restore — chat reconnects and backfills with no duplicate or missing events.
5. Close the tab, wait past the idle reaper, reopen — project restores with all files and git history intact.
6. Sign in as a second account — the first account's project is not listed and its API routes 403.

**Before declaring v1 done:** sweep `effort` (`medium`/`high`/`xhigh`) over a fixed set of five prompts, record token spend and wall-clock per turn, and lock the default.

---

## 7. Deferred to v2+ (and the seam that makes each additive)

| Deferred | Seam already in v1 |
|---|---|
| Kubernetes sandbox pods, autoscaling | `SandboxManager` (+ its conformance suite — a K8s impl must pass the same tests) |
| Redis Streams event bus | `EventBus` |
| Prometheus / Grafana / Loki / OTel | structured logs with turn-scoped fields |
| Billing, quotas | per-turn usage already accumulated by `LLMProvider` |
| Monaco editing, xterm terminal | file tree already reads from the sandbox FS |
| Cheap-model routing (titles, summaries) | `LLMProvider` |
| **Long-term memory** | `MemoryProvider` call sites live in `ContextEngine`; `events` is the substrate |
| **Multi-agent** | `Runtime` — a `MultiAgentRuntime` fans out to several `AgentService` runs and joins their event streams |

---

## Sources

- [How Lovable and Bolt Work: Architecture of AI App Builders — Beam](https://www.beam.cloud/blog/agentic-apps)
- [Daytona vs E2B in 2026: which sandbox for AI code execution? — Northflank](https://northflank.com/blog/daytona-vs-e2b-ai-code-execution-sandboxes)
- [E2B vs Daytona: Sandbox Comparison — ZenML](https://www.zenml.io/blog/e2b-vs-daytona)
- [Building agents with the Claude Agent SDK — Anthropic](https://claude.com/blog/building-agents-with-the-claude-agent-sdk)
