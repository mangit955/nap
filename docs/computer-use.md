# Computer use implementation and free checks

The rollout decisions are in [ADR-0018](adr/0018-the-agent-gets-a-computer.md). The [map](https://github.com/mangit955/nap/issues/137) tracks completed and deferred work.

## App test backend

The owner posts a completed job ID and an allowed image-capable model to `POST /sessions/:sessionId/tests`. Arbitrary prompt fields are rejected. Admission uses the same credential resolver, ceilings and queue as ordinary turns. The durable queue stores kind `test` and the approved job ID; the worker reopens credentials and carries cancellation under the ordinary session lease.

Under that lease, runtime confirms the latest job is completed at its checkpoint, actual sandbox HEAD matches, and tracked/untracked source is clean. It reads the full job diff, including repair commits, and constructs a bounded source-informed test prompt. `test.started` records the goal and source commit. The prompt is not stored as a historical user request, because those are protected against eviction and compaction. The existing system prompt is unchanged. Active-test compaction reintroduces the generated prompt as the current request; ordinary continuations still recover their prompt from durable history.

App tests offer source-reading tools and the image-gated computer. The executor also refuses invented write/edit/command calls. These turns have a separate budget, perform no git commit, and never enter deterministic arbitration or automatic repair. Their assertions do not advance a checkpoint.

`AppTestRun` is the assertion ledger. Setup precedes test chapters. An assertion first records an ID, expectation and `untested` result. Computer input requires a pending expectation. A verdict must match that ID and expectation in the current chapter, follow input, and follow a newer stored screenshot. `test.annotation` carries the annotation and its time in milliseconds: on the recording's clock while one runs, otherwise elapsed since the test started. `test.completed` carries distinct assertion counts and whether execution completed or was interrupted. These sequence guards cannot establish whether a model's visual judgement is true; that is the benchmark's question.

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
composes the E2B desktop adapter unconditionally, so a deploy turns it on. A composition test
was seen failing without that wire. The preview provider has a collected unit
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

## Desktop builds

The desktop image and the runtime that drives it are deployed separately, so the adapter refuses
to drive any machine whose image is not its own build. `DESKTOP_BUILD`
(`packages/sandbox/src/desktop-build.ts`) is a hash of every source the image runs: the start
script, each module the driver bundle inlines, and the image's installed packages. Preparing the
template writes it into the image; every driver command first compares the two and, on a
difference, runs nothing and returns `outdated`. The agent is told its computer is unavailable
and why, the Computer pane shows its unavailable state, and owner input is refused as on a
machine without scoped input. The rest of the project keeps working.

That covers both ways a machine ends up behind: a deploy ahead of the published template, and a
machine created before the last publication. Only republishing fixes the first. Closing and
reopening the project fixes the second, once the template is current.

Changing any of those sources fails `desktop-build.test.ts` until `DESKTOP_BUILD` is updated,
and publication refuses a prepared image whose build is not this checkout's. The deploy order is
in [DEPLOY.md](DEPLOY.md#release-production).

## Verified on a VM

On 2026-11-07 the template was republished from `e35c80cd` (E2B build
`7961b3ba-59c8-4dc8-8f95-9a270e320ff3`, `DESKTOP_BUILD` `a89efce5…`, Chrome 156.0.8078.47) and one
VM ran a full turn and an app test. It ran under the production composition (`bootNap`: the API
and worker processes, a Postgres event bus, the E2B desktop adapter and the R2 object store) with
`anthropic/claude-sonnet-5` on the account's own OpenRouter key; only the database was a local
throwaway. The image's build file matched, so the gate let every command through.

- The build turn made a kanban app (16 tool calls, 201,565 input and 6,438 output tokens, 109 s);
  typecheck and build passed and the job completed as `verified`.
- The app test started the desktop, took four screenshots, recorded two assertions and passed both
  (82,779 input and 1,353 output tokens, 43 s). Annotation times fell on the recording's clock.
- Screenshots and the 44.6-second H.264 recording were stored in R2 and served back through the
  owner routes, the recording by byte range; a seek decoded. Chrome's `--no-sandbox` warning bar
  is gone from the recording.
- The owner stream route returned credentials, and its WebSocket answered `RFB 003.008` through the
  sandbox's public proxy. Owner input while idle applied three actions.
- Deleting the project removed all nine of its R2 objects and destroyed the VM.

**One GiB had almost no headroom, so the machine is now 2 GiB.** E2B's per-VM metrics (one sample
every five seconds) put peak use at 915 MiB of the 976 MiB the guest saw, during the app test, with
the Vite dev server (369 MB RSS), Chrome (about 330 MB across its processes) and the recorder
running. After the test 145 MiB was available, with no swap. No process was killed, but this was a
small app. The template was republished the same day at `DESKTOP_MEMORY_MB` (2,048 MB, build
`5a818218`, same desktop build); a fresh machine from it reports 1,982 MiB to the guest, about a
gigabyte above that peak. The full run was not repeated at the new size.

## Current limits

Machines created before that publication report `outdated` until their project is closed and
reopened. Desktop behavior, screenshot bytes and model responses in the free checks are fakes. The
app test cards and explicit Fix it UI are separate from the backend.

Actual Computer pane and work-log browser evidence is under [panel review](assets/computer-use/panel-review/README.md) and [work-log review](assets/computer-use/work-log-review/README.md). The standalone mockup is design evidence, not proof of the live desktop or recording transport.

Backend gates passed: full tests, typecheck and lint. The existing CSS specificity warning and stale browser-data notice remain unchanged. The app-test runtime, ledger, prompt and target suites appear in `vitest list --project unit`. Production desktop and provider behavior remain unmeasured.
