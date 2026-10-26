# Recording pipeline review — uncommitted diff on cdee93f (feat/computer-use)

Scope: runtime recording lifecycle, encoder-clock annotations, durable `test.started` deletion index,
owner-only ranged video route, compose/boot wiring, structured `TurnAbortError` (incl. cancel → later
lease loss), janitor orphan cleanup. Read-only; nothing edited.

Focused tests (unit project, 9 files: app-test-recording, app-test-run, app-test-runtime, janitor,
delete-project, turn-worker, recordings route, turn-abort, test-recording): **126/126 passed**.
Mutation logs: `/tmp/nap-recording-pipeline-mutations.log` shows all 13 guards observed failing
(reservation, upload-await, clock, lease-before, lease-after, delete-index, pointer-release,
pointer-fence, orphan-discard, media-owner, media-range, media-suffix, media-key). The two later-lease
logs show the cancel-then-lease-loss guards failing for the right reason (`available` instead of
`lease_lost`; `reason.leaseLost` staying false).

Verdict: **no blocking defect found.** One medium ordering regression worth fixing before real
cloud validation; the rest are low or hypotheses.

## Findings

### 1. MEDIUM (ordering confirmed from the code; whether it shows up depends on Chrome) — on a freshly created sandbox, the desktop and capture start before the dev server is confirmed up
`packages/runtime/src/single-agent-runtime.ts:637-674` and `packages/runtime/src/app-test-recording.ts:42-51`

`withAppTestRecording` calls `desktop.start` and `recordings.begin` before `run`. `#announcePreview`
(which is `waitForPreview`) now runs **inside** `run`, so it comes after capture starts. Before
this diff, the agent's first `computer` call (which is what used to start the desktop) came after
`#announcePreview`.

`packages/sandbox/desktop/start-desktop.sh:25-26` launches Chrome once at `http://localhost:$port`
and never waits for that port. Later `start` calls (`packages/agent/src/tools/computer.ts:25`) find
Chrome already running and don't reload it.

Reproduction: run a test turn whose sandbox was reaped, so `acquired.value.created === true` and
the dev server is still booting. Chrome's first navigation gets a connection-refused page. That
page is what the recording opens on, and it's the agent's first screenshot. The agent has to
diagnose it and reload, at its own cost, and the video shows an error the app never had. No test
covers a test turn on a created sandbox (`app-test-runtime.test.ts` has no `created`/`preview.ready`
case).

Uncertain: whether Chrome's error-page auto-reload hides this in the real template. Not verified
without E2B.

Fix: move the notices and `#announcePreview` into `beforeCapture`, after `sink.drain()`. That keeps
`test.started` first and the drain before capture, and restores "preview serving before the desktop
opens it". Add a runtime test with `created: true` that checks `waitForPreview` resolves before
`desktop.start`.

### 2. LOW (hypothesis; timing race) — a stale encoder can make the next test's `begin` fail
`packages/runtime/src/janitor.ts:182-199` with `packages/sandbox/src/desktop-recorder.ts:207-211`

The recorder allows one active recording per sandbox. The janitor only discards an abandoned
capture in `announce`, which runs after `orphanExpired` has already freed the session's in-flight
slot.

- If a new test request is claimed in that window, its `begin` hits "A recording is active." and
  the new test records `capture_failed`.
- The window is milliseconds normally. It becomes a whole sweep tick when `announce` fails and
  retries (event append failure, `sessions.get` throwing, a discard exec timeout).
- A failed discard leaves the stale encoder blocking capture for up to its 600 s cap.

The assertions are kept and only the video is lost, so this is low. A possible fix: in `begin`,
when the active recording belongs to a request whose lease is gone, discard it and continue.
Alternatively, accept and document the race.

### 3. LOW (hypothesis; known limit) — "a lost lease can never announce available" only holds once the worker has seen the loss
`packages/runtime/src/app-test-recording.ts:82-92`

`leaseLost()` only knows what a successful renewal reported. If renewals are *throwing* (the
database can't be reached, `turn-worker.ts:323-328`), the lease can expire and the janitor can
write `lease_lost` and `test.completed: interrupted` while the worker still thinks it holds the
lease. The worker then uploads and emits `available`, and `findLast` in the route
(`apps/api/src/computer/recordings.ts:48`) serves it. The clip itself is genuine, so the harm is
small.

A related case: a zombie whose `put` lands after `deleteProject` has already read the index and
deleted its keys leaves an orphan object.

ADR-0018 now says "including when authority was lost during upload". Consider adding "once
observed" so the doc doesn't overclaim.

### 4. LOW (efficiency) — every range request downloads the whole object
`apps/api/src/computer/recordings.ts:62-90`

`objects.get(key)` loads the full MP4 (up to 16 MB) for every GET, HEAD and range request.
`<video>` playback and seeking send many range requests, so each seek is a full R2 read plus a
copy (`Uint8Array.from` on the unranged path). It is correct, but bandwidth and memory scale with
seeks. A ranged `ObjectStore.get` or a short-lived cache would fix it. This is not a correctness
blocker.

Minor: a `Range` header in an unknown unit (e.g. `items=0-1`) or with multiple ranges returns 416.
RFC 9110 says to ignore it and return 200. Browsers don't send either for media.

### 5. LOW (wrong reason) — a cancel or lease loss before capture starts is reported as `capture_failed`
`packages/runtime/src/app-test-recording.ts:42-56,74`

If the signal is already aborted when `desktop.start` or `begin` runs, both return `cancelled`, and
the final event says `unavailable/capture_failed`, even when the reason is `lease_lost`. This only
affects UI copy and telemetry. Mapping `leaseLost()` → `lease_lost` in that branch would fix it.

### 6. NOTE (rollout) — boot now composes the desktop for every role
`apps/api/src/boot.ts:193,344-349`

Once this deploys, image-capable models are offered `computer`, and app tests are enabled, before
the desktop template is published. Every desktop call then fails at runtime. Recording degrades
safely to `capture_failed`, but the agent's normal turns would see a broken tool. DEPLOY.md/ADR say
publication is pending. Make sure this branch doesn't reach the production deploy before the
template does, or gate the composition on an env flag. Out of this unit's scope per the brief; it's
flagged only as an ordering hazard.

### 7. NIT
`packages/runtime/src/turn-worker.ts:1` and `apps/api/src/turns/registry.ts:1`: the new import
now sits above the module's doc comment, so the comment no longer leads the file. Same for the stray
blank line at `apps/api/src/compose.ts:3`.

## Checked and found sound
- `TurnAbortError`: every production `abort()` site uses it (worker lease/cancel/shutdown, registry
  cancel). `markLeaseLost` on an already-set reason works because the renewal interval runs until
  `execute` returns, and recording finalization happens inside `execute`. `options.signal` is the
  controller's own signal, so the mutation is visible.
- Pointer release in `#attempt`'s `finally` is skipped once the lease is lost, and runs after a
  cancellation.
- Deletion index: each `test.started` derives the key with the same `computerRecordingKey` the
  runtime uploads to and the route checks. It can't collide with screenshot keys (`.jpg` vs
  `/recording.mp4`). The log is kept if reading or deleting fails.
- The route checks ownership through `findOwnedSession` under the global `requireUser`, validates
  `turnId` as a UUID, and checks start-before-recording order and the derived key. GET and HEAD
  are both in `GUARDED_ROUTES`. Suffix, open-ended, clamped and unsatisfiable ranges are handled.
  `body.buffer` is exact-length because both paths copy.
- Encoder clock: bounds (0 to 605 000 ms) match the schema and the 600 s encoder cap. After the
  clock is lost, annotations fall back to wall time, but the video becomes `timing_failed`, so
  mixed timelines are never advertised. Tool calls run one at a time (`agent-service.ts:428`), so
  async `annotate` can't reorder emissions.
- Janitor: discards by `request.id` (== turnId), and emits `lease_lost` only when the last state is
  `started`, so retries don't duplicate it.
