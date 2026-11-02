# ADR-0022 — The photograph leaves the lease, and the snapshot stays

**Status:** Accepted, 2026-11-02. Built and tested on fakes and a real local git repository. Not yet measured against a real E2B sandbox or a real Chromium.

## Context

When the agent finishes, `turn.completed` reaches the chat pane, but the worker still holds the session's lease while it verifies the job, snapshots the repository and photographs the app for the dashboard card. A follow-up message is queued behind that lease and cannot start until all three end.

The photograph is the slowest of the three and the least important. It waits up to 15s for the preview, up to 20s for the page, and then pauses before uploading. Before this change it ran behind a per-worker semaphore of one (B-6) with no limit on its queue. With 25 turns finishing together on one worker, the last turn kept its lease until 24 other projects had been photographed.

## Decisions

### D1: The photograph is taken outside the lease, by a `ThumbnailLane` the composition owns

Under the lease, the turn only *asks* for a picture. That takes one sandbox command, which reads which commit is checked out and how the working tree differs from it. The lane takes the picture after the lease has gone back. Concurrency stays `NAP_CAPTURE_CONCURRENCY`, as B-6 decided, and the composition chooses both numbers: how many may run, and how many may wait (`NAP_WORKER_CONCURRENCY`, the most turns that can finish together).

Leaving the lease means nothing holds the sandbox still, so the lane follows four rules:

- **It never replaces a good picture with a worse one.** It reads the workspace again before launching a browser and before storing the bytes. If the workspace has moved, because a following turn is editing it or a close destroyed it, the card keeps the picture it already has. A turn that later commits asks for a new one.
- **It is bounded by dropping.** Each project holds one place in the queue, and its newest request replaces the older one. When the queue is full, a new project's request is refused. Overload costs stale cards, never memory.
- **It keeps no sandbox alive.** It never creates, resumes or extends one, holds no slot of the ceiling, and makes no session busy. The idle sweep and a close go straight past it.
- **A shutdown does not wait for it.** Stopping the worker drops what is queued and gives what is running a short grace. Nothing in the lane is durable, so a process that dies loses only those pictures.

The workspace read uses `git --no-optional-locks status`. A plain `git status` takes `index.lock` to refresh the index, and a turn's `git add` that meets that lock fails, which fails the commit. Against a real repository, 4 of 300 `git add`s failed beside a plain status and none failed beside this one.

A turn that was stopped, or whose checks failed with a repair still to come, asks for no picture. The first may have lost its lease (`docs/scaling-design.md` §21, 10). The second's app is one its own checks just called broken.

### D2: The snapshot stays under the lease

We tested the audit's suggestion that the snapshot could move as well, and rejected it. Three things depend on the bundle being recorded before the lease goes back:

- **A restore reads the newest snapshot row.** If the next turn's sandbox is lost and restored before this turn's row exists, it restores from the turn before and silently forks the project.
- **Two snapshots of one project are ordered only by never overlapping.** The next turn may run on another worker, so nothing in one process can order them.
- **The idle sweep asks `anyLeased`.** A snapshot outside the lease could have the sandbox put away, or destroyed, partway through the bundle.

Making the snapshot safe outside the lease would mean a second, durable claim on the project that the sweep, restore and the next turn all respect. That is a second lease, and it would cost more than the seconds a bundle takes.

### D3: Typecheck and lint run together only when both are recognisably read-only

`discoverChecks` marks a check `readOnly` from an allowlist: a single `tsc --noEmit`, or a single `eslint`, `oxlint` or `biome check|lint|ci`, with no shell syntax and no flag that writes. `runChecks` runs that pair at once and uses the result only if both pass. Any other result is discarded and the pair runs again one at a time, so the verdict, which check is blamed and the event order never depend on which one finished first. Build and test never run beside anything, because they share output directories and ports.

The template declares `typecheck` and no `lint`, so a fresh project gets nothing from this. It applies once a project adds a lint script that qualifies.

## Consequences

- A follow-up message waits for verification and the snapshot, but no longer for a browser.
- A card can be one turn stale, or keep the previous picture when a project is closed within seconds of its last turn. That was already possible when a capture failed.
- `BoundedPageCapture` is gone. The lane's bound replaces it, and it starts work without yielding, so no permit can be handed out twice.
- Reversing D1 means awaiting the shot inside `#photograph` again. Reversing D2 needs the second claim described above.
