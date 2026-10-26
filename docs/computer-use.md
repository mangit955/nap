# Computer use implementation and free checks

The rollout decisions are in [ADR-0018](adr/0018-the-agent-gets-a-computer.md). That ADR remains an implementation draft until paid desktop and transport measurements are available. The [map](https://github.com/mangit955/nap/issues/137) tracks completed and deferred work.

## App test backend

The owner posts a completed job ID and an allowed image-capable model to `POST /sessions/:sessionId/tests`. Arbitrary prompt fields are rejected. Admission uses the same credential resolver, ceilings and queue as ordinary turns. The durable queue stores kind `test` and the approved job ID; the worker reopens credentials and carries cancellation under the ordinary session lease.

Under that lease, runtime confirms the latest job is completed at its checkpoint, actual sandbox HEAD matches, and tracked/untracked source is clean. It reads the full job diff, including repair commits, and constructs a bounded source-informed test prompt. `test.started` records the goal and source commit. The prompt is not stored as a historical user request, because those are protected against eviction and compaction. The existing system prompt is unchanged. Active-test compaction reintroduces the generated prompt as the current request; ordinary continuations still recover their prompt from durable history.

App tests offer source-reading tools and the image-gated computer. The executor also refuses invented write/edit/command calls. These turns have a separate budget, perform no git commit, and never enter deterministic arbitration or automatic repair. Their assertions do not advance a checkpoint.

`AppTestRun` is the assertion ledger. Setup precedes test chapters. An assertion first records an ID, expectation and `untested` result. Computer input requires a pending expectation. A verdict must match that ID and expectation in the current chapter, follow input, and follow a newer stored screenshot. `test.annotation` carries the annotation and elapsed milliseconds. `test.completed` carries distinct assertion counts and whether execution completed or was interrupted. These sequence guards cannot establish whether a model's visual judgement is true; that is the benchmark's question.

Cancellation preserves untested assertions and closes the test as interrupted. The janitor does the same after a lost worker, reading durable annotations and avoiding duplicate terminals on a later sweep. It does not requeue the test. A failing assertion never invokes a repair callback. The UI's explicit repair action belongs to the next UI ticket.

## Try the local app

```sh
bun apps/api/scripts/computer-preview.ts
```

Open `http://localhost:3037/sign-in` and sign in as `reader@computer.test` with password
`Computer-preview-42`. Open **Computer playground** from the dashboard. Its seeded history
includes a screenshot; clicking that card opens the Computer tab. Try **Test the app**, then
**Fix it**, then test again. The scripted first test fails and a test after another editing
turn passes. These outcomes demonstrate the event and UI flow, not a model finding a bug.

This starts the real web app, email authentication, API routes, queue, worker, runtime,
WebSocket and a fresh migrated Postgres container. The model, desktop, sandbox and object
store are fakes; no cloud clients are booted. API keys are refused in this preview. The Browser
tab serves a small local notes app; Computer images are synthetic fixture pixels. Live desktop
input and recording remain unavailable.

Ports are 3037 (web), 3038 (API), and 3039 (synthetic app). Stop any other Next dev process for
this checkout first, because Next holds a lock on its dev output. Ctrl-C stops these services
and removes the disposable database; local changes and accounts from that run are lost.

The desktop is injected through `composeNap`, and production boot (`apps/api/src/boot.ts`)
composes the E2B desktop adapter unconditionally, so the next deploy turns it on. A
composition test was seen failing without that wire. The preview provider has a collected unit
suite and all scripts belong to the API TypeScript program. No dependency or CI glob changed.

## Free reproduction

```sh
bunx vitest run --project unit packages/runtime/src/app-test-runtime.test.ts
bunx vitest run --project unit packages/runtime/src/app-test-run.test.ts packages/runtime/src/test-prompt.test.ts
bunx vitest run --project db packages/db/src/postgres-turn-queue.db.test.ts packages/db/src/postgres-event-store.db.test.ts
bun run harness "Exercise the computer tool"
```

The runtime test composes the real runtime, context seam, agent loop, tool executor and object-store flow with a scripted model and fake desktop. It records passing and failing tests, rejection of changed source/approval/model, cancellation, action/observation sequencing, no commit and no automatic repair. The harness command exercises ordinary computer use, not an app test. All are free; database suites use a throwaway local Postgres container.

The new queue kind needs the generated `0013_chunky_midnight.sql` migration. Database tests exercise it through a freshly constructed adapter. Deliberately replacing its ALTER with `SELECT 1` makes app-test enqueue fail. Removing expectation/observation and source-write guards also makes their tests fail. All mutations were restored.

Every new event has schema parsing, issue-path, discriminant and JSON round-trip coverage plus Postgres round trips. Logging, harness formatting, and transcript event tables include the new types. New suites are collected in the unit project and package TypeScript programs. No package dependency, architecture table, hook or CI glob changed. The benchmark's editing-only test doubles now explicitly reject app-test requests; runtime imports no benchmark code.

## Current limits

Production boot composes the E2B desktop adapter unconditionally, so do not deploy until VNC viewing, physical input and recording have passed on a real VM; what one VM has verified so far is in [ADR-0019](adr/0019-the-desktop-debugger-has-no-port.md). Desktop behavior, screenshot bytes and model responses in these checks are fakes. Annotation timestamps are elapsed from the app test; recording must anchor them to capture start. The app test cards and explicit Fix it UI are separate from the backend.

Actual Computer pane and work-log browser evidence is under [panel review](assets/computer-use/panel-review/README.md) and [work-log review](assets/computer-use/work-log-review/README.md). The standalone mockup is design evidence, not proof of the live desktop or recording transport.

Backend gates passed: full tests, typecheck and lint. The existing CSS specificity warning and stale browser-data notice remain unchanged. The app-test runtime, ledger, prompt and target suites appear in `vitest list --project unit`. Production desktop and provider behavior remain unmeasured.
