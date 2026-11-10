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
- **It keeps no sandbox alive.** It never creates, resumes or extends one, holds no slot of the ceiling, and makes no session busy. The idle sweep and a close go straight past it. "Never resumes or extends" relies on the E2B adapter's cached handle: an uncached one would `Sandbox.connect`, which resumes a paused sandbox and extends a running one's timeout. The lane runs in the process whose turn has just used the sandbox, so the handle is normally cached. Later cache eviction can cause a reconnect and extend or resume the sandbox; see [Sandbox and storage](../GOTCHAS.md#sandbox-and-storage) for this limitation.
- **A shutdown does not wait for it.** Stopping the worker drops what is queued and gives what is running a short grace. Nothing in the lane is durable, so a process that dies loses only those pictures.

The workspace read uses `git --no-optional-locks status`. A plain `git status` takes `index.lock` to refresh the index, and a turn's `git add` that meets that lock fails, which fails the commit. Against a real repository, 4 of 300 `git add`s failed beside a plain status and none failed beside this one.

A turn that was stopped, or whose checks failed with a repair still to come, asks for no picture. The first may have lost its lease (`docs/scaling-design.md` §21, 10). The second's app is one its own checks just called broken. The stop is checked once, before the request, so a lease lost after that check can still let a shot land. That is harmless rather than prevented: the lane reads the workspace again before launching a browser and before storing, so a shot that lands shows a commit and a set of changed files the new owner has not moved. It can still miss a further edit to a file that was already changed; see Known limitations.

### D2: The snapshot stays under the lease

We tested the suggestion that the snapshot could move as well, and rejected it. Three things depend on the bundle being recorded before the lease goes back:

- **A restore reads the newest snapshot row.** If the next turn's sandbox is lost and restored before this turn's row exists, it restores from the turn before and silently forks the project.
- **Two snapshots of one project are ordered only by never overlapping.** The next turn may run on another worker, so nothing in one process can order them.
- **The idle sweep asks `anyLeased`.** A snapshot outside the lease could have the sandbox put away, or destroyed, partway through the bundle.

Making the snapshot safe outside the lease would mean a second, durable claim on the project that the sweep, restore and the next turn all respect. That is a second lease, and it would cost more than the seconds a bundle takes.

### D3: Typecheck and lint run together only when both are recognisably read-only

`discoverChecks` marks a check `readOnly` from an allowlist: a single `tsc --noEmit`, or a single `eslint`, `oxlint` or `biome check|lint|ci`, with no shell syntax and no flag that writes. `runChecks` runs that pair at once and keeps what each says. The results are read by name in check order, so the verdict, which check is blamed and the output kept are already what a run one at a time gives: a failing typecheck still ends the run, and the lint beside it is reported as never reached. The one answer not kept is a command killed by a signal (an exit of 128 or more, such as 137 from the OOM killer), which runs again on its own, because two compilers in a 1 GB sandbox can get one killed and that is not the project's fault. A command that could not be run at all, such as a timeout or a sandbox that went away, is kept as it is and not run again, so a hang is not waited for twice. A check whose `pre<name>` or `post<name>` script is declared is never `readOnly`, because `bun run <name>` runs those too. A cancel reaches both of the pair, as it does any check: neither starts once it has fired, one that finished first keeps its answer, and one it stopped is recorded as cancelled, not as killed, so it is not run again. Build and test never run beside anything, because they share output directories and ports.

The template declares `typecheck` and no `lint`, so a fresh project gets nothing from this. It applies once a project adds a lint script that qualifies.

### D4: Inside a job, no round waits for a picture, and each waits for the snapshot before it (amended 2026-11-09)

D1 left one cost inside a job's repair rounds: the lane had no deadline of its own, so a browser that never answered kept its place for good. At the default bound of one, that is the last picture the worker ever takes.

- **A repair does not begin until the round before it has been snapshotted, or has failed to be.** The snapshot starts as soon as the round's checks have been run, and the job waits for it before it starts a repair, publishes, or returns. A job that passed, or has spent its repairs, is reported closed before that wait, so the person watching is not held by it. Letting a repair run while the round before it uploads was tried and reverted. A worker can die outright, with no `finally` run, and a repair that had committed by then would leave the newest durable snapshot older than both rounds. Overlapping the two safely needs a durable record of a pending snapshot that the reaper reconciles. That is a follow-up.
- **The picture is asked for once per job, at its close**, if any round of it committed. Before this, a job whose last round committed nothing got no picture, although an earlier round had changed the app.
- **Every shot has a deadline (two minutes by default), and a shutdown aborts what is left after its grace.** `PageCapture` takes an `AbortSignal`, and the Chrome adapter closes its browser when the signal fires. The lane races each shot against its own abort, so a shot that ignores the signal still gives its browser's place back at once. It stores nothing, unless its upload had already begun. A put cannot be called back, so that upload goes on holding its project's place, and the project's next shot waits for it to land rather than being overwritten by it. Those stranded uploads count against the queue's bound, so a store that stops answering costs cards rather than memory.

The alternative of moving the last snapshot off the lease is still D2's answer: it needs a durable claim of its own that the sweep, a restore and the next turn all respect.

## Consequences

- A follow-up message waits for verification and the snapshot, but no longer for a browser.
- A card can be one turn stale, or keep the previous picture when a project is closed within seconds of its last turn. That was already possible when a capture failed.
- A job's repairs still wait for a backup between attempts, which is the price of every commit being durable before the next one is made.
- `BoundedPageCapture` is gone. The lane's bound replaces it, and it starts work without yielding, so no permit can be handed out twice.
- Reversing D1 means awaiting the shot inside `#photograph` again. Reversing D2 needs the second claim described above.

### Known limitations

- **A delete can leave an orphaned thumbnail.** If a project is deleted in the moment between a shot's last workspace check and the end of its upload, the upload can complete after the delete has removed the key. Nothing serves that object, but nothing removes it either.
- **The workspace state compares paths, not content.** It is built from `git status --porcelain`, so a further edit to a file that was already dirty when the picture was asked for is not seen, and a picture of that edit can be stored.
- **An upload that never answers holds its project's place until the worker restarts.** The R2 client sets no request timeouts, so a put can stay pending indefinitely, and enough of them stop that worker taking thumbnails at all. Snapshots under the lease share the same client and hang the same way. The fix is request timeouts on the R2 client, left as a follow-up.
- **Two checks at once may be too much for 1 GB.** A killed check is run again on its own, but the OOM killer may pick the dev server instead, and then the preview probe after the checks fails and is charged to the project. This is unmeasured.
