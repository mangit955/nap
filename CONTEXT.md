# Context

The words this codebase uses for the things it is about, so that one concept has one name. Added
to when a term actually gets resolved rather than upfront — see `docs/agents/domain.md`. What v1
*is* lives in `docs/PLAN.md`; why the code is shaped the way it is lives in `docs/gotchas/`.

## Glossary

**Project** — what a user is building: a name, an owner, files, and at most one sandbox serving it
at a time. Outlives every sandbox it ever had.

**Session** — one conversation about a project. A project's newest session is the one its workspace
opens; a link never names a session, because the project grows new ones.

**Settled** — of a session in the sidebar: finished with, and so out of the inbox, on the Settled
shelf at the bottom. Settling is the reader's own bookkeeping, not a fact about the work, so a
new request un-settles a session by itself; a turn still running cannot be settled. The API,
the store and the reorder `section` call it **done** (`navigation.doneAt`), and keep that name on
purpose: it is a persisted field and a wire value, the web maps it in one place
(`shelveSessions`), and renaming it would migrate stored rows to change no behaviour. Not a
**Verdict** and not a closed **Job** — a session can be settled with its checks red.

**Auto-settle** — the reaper settling a session on its owner's behalf: after a number of days
with nothing happening in it, or when its pull request merges after its last turn. Both rules are
the owner's settings and off until turned on; a pinned, snoozed, archived or busy session is never
auto-settled, and a snooze that has ended counts as activity, so a session that woke is not filed
away before anybody saw it. The merge counted is the moment the integration recorded the pull
request merged (`pull_request_merged_at`), not the job's last refresh. Taking a session back out of
Settled stamps `auto_settle_floor`, and nothing at or before that moment can settle it again — so
un-settling sticks until new work arrives.

**Name source** — where a project's name came from: `seed` (the first prompt trimmed by
`titleFromPrompt`, written at once), `model` (a title a model wrote afterwards, or on **Regenerate
title**), or `user` (typed by the person, by renaming it or when creating the project). Nothing automatic ever replaces a `user` name, and a
rename always wins over a title still being written. See docs/adr/0031.

**Woke** — a snooze that has run out on a session nobody has looked at since. It comes back to the
inbox saying *Woke* until it is opened or dismissed, which moves the read watermark past the
wake. Only ever drawn, never stored: it is `snoozedUntil` in the past and `readAt` before it.

**Media attachment** — a named reference on a user message: one prepared JPEG for an image,
or sampled JPEG frames with timestamps for a video. These bytes travel with the durable turn
request and event; the original file and video audio do not. A text-only model sees a named
omission marker for historical references, while a new reference requires a model with image
input. See [ADR-0015](docs/adr/0015-media-references-travel-with-the-prompt.md).

**Turn** — one exchange within a session: a prompt, whatever the agent does about it, and exactly
one terminal event (`turn.completed` or `turn.failed`). The unit budgets, cancellation and commits
are all scoped to. **The prompt comes from the user or from failed verification** — a repair is a
turn and not a smaller thing, which is why it inherits budgets, cancellation, event ordering and
commit-on-completion without any of them being rebuilt. `turn.completed` is the *model's claim*
that the work is done, not the system's finding; see **Verification**.

**Job** — one objective, and the durable unit of work that outlives a turn: what was asked, what
phase it is in, what has been verified, how many repair attempts remain. A fold over the session's
events exactly as a turn is, with no table and no file behind it, so there is one source of truth
and resuming is replaying. Every turn belongs to one. A job opens on a prompt and stays open until
verification agrees it is satisfied or its attempts run out — so a trivial request is a job that
opens and closes in a single turn, and a large one is a job that spans six, without anything having
to decide in advance which it is. **Not a benchmark's task**, which is a specification of work to
be repeated; a job is one actual piece of work being done once. See `docs/adr/0006`.

A job is *working*, *verifying* or *repairing* while it is open, and once closed its phase is how it
ended: **verified** (checks passed, so the commit is a checkpoint), **unverified** (the turn changed
no files, so there was nothing to check — not a failure and not a success), **exhausted** (three
repairs spent with checks still red) or **abandoned** (the turn it was riding on was cancelled or
refused, or its checks came to an errored verdict). `foldJobs` in `@nap/shared` is the one function
that decides all of it.

**Verification** — what the system finds, as against what the model claims. A turn that changed the
workspace is committed and then checked: the project's own checks, cheapest first, stopping at the
first failure. Passing makes the commit a **checkpoint**; failing opens a repair turn carrying the
failure. Bounded by attempts rather than by a token ledger, and confined to sandbox commands and a
preview probe. Agent computer use is a separate image-gated capability under ADR-0018;
agent-reported assertions do not change the deterministic checkpoint.

**Review** — a second model's check of a job's work against what was asked, after the checks pass
and before an imported repository's job is published (ADR-0036). It reads and runs commands and
never edits. A **proved** problem (one a command it ran in that review shows, quoted from that
command's output) opens a repair turn, recorded as a failed `review` check; everything else it says
is a note. Not a helper: the system calls it, not the agent. What a review that returns cost is in
the log as `review.completed`, outside any turn's usage, and the **session's usage** adds it.

**App test** — a user-approved, system-prompted Turn that exercises the latest completed Job in
its Computer. Its goal and source commit are recorded in `test.started`; its input prompt is
built from that goal and the Job's diff. Assertions are declared before input and receive a
verdict after a new screenshot. The result does not change the Job's checkpoint. A failed
assertion offers a separate repair the user may request; it never starts one itself.

**Goal** — what an **App test** of a Job is judged against. Usually the Job's objective. A Job
opened by **Fix it** has the repair prompt as its objective and the failed test's goal as its
goal, copied from that test's `test.started` by the runtime. Structured repairs preserve this goal
without reading it from the repair prompt. Older logs fall back to the objective and are not backfilled.

**Test recording** — a video of one App test, with annotations on the video’s timeline. It shows
what was attempted and what was visible; it does not independently establish an assertion’s truth.
An interrupted or missing recording leaves the test’s assertions available for review.

**Session usage** — the tokens a session spent on its completed turns, the project's title, and its
reviews that returned. A compaction or a helper ran inside a turn and is already in that turn's total. A failed
turn writes no total, so it is left out whole, even the compaction or helper usage its own events
recorded. Tokens, not money: the log does not say which model each turn ran on. Defined by `sessionUsage`
(`@nap/shared/session-usage`).

**Check** — one command, run in the sandbox, that passed, failed, or was **absent**. Absent is not
failure and the gap is load-bearing in both directions: a project with no `test` script has not
failed its tests, and treating a missing script as a failure would put every fresh project into a
repair loop it cannot leave. Which checks exist is discovered from the project rather than declared
by the model. Owned by `@nap/verify` (`docs/adr/0007`). The passed/failed/absent triple itself sits
one layer lower still, in `@nap/shared`, because `verification.completed` carries it into the log.

**Check output** — what a failed command actually said, kept on the check beside the exit code it
does not explain. Recorded only on failure and only when there was something to record, because a
passing build's output is churn in an artefact people diff. Each stream is budgeted on its own and
keeps its **tail** — a failing command prints its banner first and its reason last, and a shared
budget would let a chatty stdout push out the stderr that explains the failure. A stream says
whether it was truncated, so a fragment is never read as the whole.

**Verdict** — what a whole *run* of the checks came to, as against the outcome of any one of them:
**passed**, **failed**, or **errored**. The third is the one worth the word. Failed is the project's
and opens a repair turn; errored means nothing was learned about the project — the sandbox refused
the command, a check ran past its limit or was cancelled, or the preview listens inside and is
unreachable from outside — and a repair turn on that would ask a model to fix something it cannot,
so its checks come back *absent*. **An
errored run is never written as a verification.** `verification.completed` carries checks and no
verdict on purpose, and an all-absent payload folds to `verified`; the job ends **abandoned**
instead. `runChecks` in `@nap/verify` is where a verdict comes from, and it is branched on before
anything is persisted rather than persisted itself.

**Job brief** — the `<job>` section of the **turn context**: the job's **objective**, and the
verification failures already seen on it, oldest first. The second half is procedural memory done
deterministically — a transcript shows the model confidently finishing, never that the finish was
rejected, so without this each repair is free to make the last one again. Near-unevictable, and
that is the point: the situation it exists for is a long repair with a full context, which is
exactly when the turn that stated the objective has fallen out of the window. Handed to the
`ContextEngine` like `history` is, because the component that owns the token budget performs no
I/O. `renderJobBrief` in `@nap/context` writes it.

**Stale** — of a past turn in the assembled conversation: finished — its `turn.completed` or
`turn.failed` is in the log — so its tool traffic is emptied whether or not the budget needs the
room, from the first build after it ended, so that history a cached request already sent is never
rewritten later (ADR-0024). A turn still running never is, and nor is the exchange a compaction kept
from it. What survives is prose on both sides, each call's small arguments — which tool, against
which path — and the whole of a question put to the person, so the turn still reads as something
that happened; what goes is any other argument large enough to be a file's contents, and everything
the call printed. Distinct from **truncation**, which is the ladder `ContextEngine` climbs when a context
does not *fit*: staleness runs first and runs always, because a turn re-sends its whole transcript
on every round trip and a thing that fits can still be a thing not worth ten copies. See ADR-0011.

**Turn context** — what the model is told that changes from one turn to the next: the file
listing, the **skill** listing, the **job brief** and memories. It rides at the end of the turn's own message, never in the
system prompt, so the system prompt and the settled history stay a prefix a provider can cache
(ADR-0024). `turnContext` in `@nap/context` writes it.
_Avoid_: system prompt, for any of it.

**Compaction** — replacing older working conversation with a summary while retaining the original
transcript. A **compaction checkpoint** is the saved summary and the conversation boundary it
covers; it says nothing about whether the project's code is verified.
_Avoid_: checkpoint without the compaction qualifier, deleting history.

**Compaction history** — the conversation compaction summaries replaced, written as a plain-text
file in the project's sandbox for the agent to search. Entries are named by event number, which
the summary cites. A derived view of the session's events, like the **Transcript**: rebuilt from
them whenever a sandbox lacks it, and never read back as a record. See ADR-0021.
_Avoid_: history file without the compaction qualifier, transcript (that is the reader's view).

**Checkpoint** — a *verified* commit, and the answer to "is this project in a valid state right
now", which is `HEAD == last checkpoint` rather than a judgement anybody renders. Distinct from a
**Snapshot**, which is a filesystem archived because a sandbox went away: a checkpoint is about
whether the work is sound, a snapshot about where the work is kept. Every completed turn commits;
only a verified one checkpoints, which is what makes a failed verification unable to corrupt the
last known-good state by construction rather than by care.

**Continue** — what happens to an open job when somebody next presses Resume on its project, as
distinct from **resume**, which already means bringing a put-away project's sandbox back up
(`resumeSession`). A process restart leaves a job open rather than failing it; nothing continues a
job while nobody is watching. A message sent instead does not continue it: it closes it as
*superseded* before its own job opens, unless the log already answers it (`closingForNewJob`).
The word means the same as for a **Proposed plan** (replaced by a newer message), but the two are
different things: a superseded job is a stored outcome, `job.completed { outcome: "superseded" }`,
while a superseded plan is only folded from what came after it.

**Turn request** — a durable, queued intent to execute, and one row in `turn_requests`. Created by
an API pod at admission, claimed by exactly one worker, terminal exactly once — *queued*, then
*leased*, then one of *done*, *failed* or *orphaned*, with **no path back to queued**. Its *kind* is
`turn` or `resume`. **Not a Job**: a job is one objective folded from the event log, and one request
may drive a job through several turns — the prompt and its repairs. It carries *whether* the asker
pays, never their key, so no credential is ever in that table. A request is claimed at most once,
which is what makes queue delivery at-least-once and logical turn execution at-most-once.
An ordinary request's identity also identifies its first Turn. A *repair* is a distinct Turn
owned by the request executing it, which can be a later resume request continuing an older Job.
It shares that request's lease, not its identity. See `docs/adr/0009` and `docs/adr/0017`.

**Session activity** is whether a session has work waiting or executing. The browser observes
activity; it does not grant permission to execute. A historical turn can remain unended in the
log while its request is no longer active. See `docs/adr/0017`.

**Lease** — a worker's time-bounded, exclusive claim on a session, and what took over from the
in-process `SessionQueue` as the thing that makes a session's turns serial. The `SessionQueue` is
still there and is now a *second, in-process line* rather than the only rope: it serialises two
turns that happen to land in one process, and it could never have serialised two processes. Held by
at most one worker per session cluster-wide, enforced by the partial unique index `unique (session_id) where state = 'leased'` rather than by application logic — two callers in
two processes cannot agree about anything a database is not adjudicating. Renewed on a timer, and
**renewal is conditional on the request id, the owner and the state**: renewing is how a worker asks
whether it is still allowed to run, and zero rows back means the lease is gone and the turn must be
aborted at once. Losing a lease never requeues the request — see `docs/adr/0009` for why there is
no requeue path at all.

**Janitor** — what closes out a turn request whose worker never came back, as distinct from the
**reaper**, which puts away projects nobody is looking at. It waits past the lease's **grace
window** — a *fence*, not a timeout: renewal is conditional, so the previous worker has certainly
aborted by then, and reclaiming earlier is what would put two writers on one session — then marks
the request *orphaned* and closes its identifiable unfinished Turns, including repairs.
**It never requeues and never closes the Job**: re-executing with nobody watching
is what *Continue* forbids, so the work waits for a human to press Resume on the project, or to
send a message, which supersedes it.

**Role** — which part of the deployment a process is: an **API pod** serves HTTP, WebSockets, auth
and admission and executes nothing, a **worker** claims leases and executes turns and serves
nothing, and the **reaper** runs the periodic sweeps and does neither. All three are the same
composition given a different role, so it names a *process's job* and never a build, an image or a
code path. `all` is the three in one process, which is what tests and the load harness compose.

**Sweep lock** — what makes the reaper one sweeper rather than one replica. A session-level advisory
lock, asked at the top of every idle-sweep tick and every **GitHub sweep** tick and held on a
connection of its own; a process that does not hold it does nothing that tick. It exists for the
seconds of a rolling update when two reapers are running, and it guards those two sweeps alone —
the **janitor** beside them is safe to run twice over and deliberately unguarded.

**Busy** — whether any of a project's sessions holds a *lease* right now. One question with one
answer for the whole cluster (`TurnQueue.anyLeased`), asked by closing a project, deleting one, and
the idle sweep. It is a **filter, not a lock**: it describes the instant it was asked, and a turn
starting immediately afterwards loses its sandbox and is restored from the snapshot the sweep just
took. Holding a lock across a teardown instead would let a wedged sweep block turns.

**Viewer** — somebody with a project's workspace open in a *visible* tab, which says so over its
`/ws` socket when it opens, when the tab becomes visible, and beside each heartbeat reply
(`projects.viewed_at`, written at most once a minute). A viewer is **activity, not busy**: it
keeps the idle sweep off the project and the provider's deadline pushed back, for at most
`NAP_VIEWER_KEEP_WARM_MINUTES` past the project's last real activity, but never stops a close or a
delete. A connected socket alone is not a viewer, because a background tab answers the heartbeat
too.

**Drain** — what a worker does between `SIGTERM` and exiting: stop claiming, keep renewing the
leases it holds, and wait for the turns already running. Bounded by the **drain timeout**, past
which the rest are aborted — a clean stop, committing nothing and closing each Job *abandoned*,
never a kill. Draining is a property of a process going away; it is not cancellation, which is
somebody asking for one turn to stop.

**Fanout** — delivery of an already-persisted event to whichever API pods hold subscribers for its
session. Strictly after the append, as it has always been. **A notification is a wake-up signal; the
durable log is the delivery** — a lost notification costs latency and never costs an event, because
the catch-up read is what actually hands anything to a socket. The notification carries
`{sessionId, seq}` and never a payload; see `docs/adr/0010`.

**Cancel wake-up** — a notification that a turn request's `cancel_requested` has been committed,
telling the worker running that request to renew now instead of at its next interval. It names a
request, never a session, and cancels nothing itself: the renewal's answer does that, and a lost
wake-up costs a wait of up to one renewal. See `docs/adr/0023`.

**Claim wake-up** — a notification that a turn request may have become claimable: one was
enqueued, a lease was settled, or the janitor reclaimed one. Every idle worker hears it and asks the
queue at once rather than at its next poll. It carries nothing and claims nothing itself; a lost one
costs a wait of up to one fallback poll. See `docs/adr/0027`.

**Session list notice** — a notification that something a user's session cards draw has changed: a
turn queued, started or finished, a rename or title, a shelf change, a pull request or its feedback.
It carries the owner's user id and nothing else; every API pod hears it and tells that user's
`/ws/account` sockets, and each tab reads `GET /sessions` again. A lost one costs a wait of up to the
tab's five-minute backstop read. See `@nap/shared/ports/session-list-channel`.

**Event** — one durable, ordered fact about a session, identified by its `seq`. Appended to the
store *before* it is published to the bus, never the other way round.

**Session log** — the ordered, append-only run of a session's events *as a client holds it*: one
socket, one `seq`, many derived views. Distinct from the `EventStore`, which is where events live;
the log is one reader's copy of them. In the browser it is `useSessionLog`, and there is one per
workspace — a second one is two clients that can disagree about what the newest event was.

**Transcript** — the conversation a reader sees, folded from a session log. Much shorter than the
log it comes from, because one tool call, everything it printed, the files it touched and how it
ended are four kinds of event and a single thing on screen. **A derived view and never state**: it
is recomputed from the log every frame and nothing is ever written into it, which is why joining
mid-turn, reloading the page and watching from a second tab all land on the same picture without
anything having to be reconciled. Its speakers are the user, the agent and the **verifier**, which
is a fact about the log rather than a third party to the conversation. `chat/transcript.ts` in
`apps/web` is the fold; a second view over the same log is another fold, not another copy. See
`docs/adr/0008`.

**Replay** — a real session's log kept in the repository (`apps/web/src/replay/recordings/`) and
played back to anybody at `/replay/<slug>`, in the workspace's own panes, on a clock. It carries
the files the session started from, each file it changed, and static builds of the app that stand
in for the preview, because the sandbox behind it is gone. Watching one makes no request, so it
starts no sandbox and calls no model. Only real sessions, never made-up ones. Not the socket's
catch-up after a connection opens, which the stream code also calls a replay (`useEventStream`,
`SessionLog.replayed`): there it means "everything after `seq` has arrived", and a replay's own
log says `replayed: true` in that sense, because all of it is in hand.

**Toolset** — the tools one turn is *offered*, as against the closed list of tool names the log
accepts. Chosen from facts about the turn — who asked, what is wired, the model's family, whether it
is a helper — and never from preference. A real tool outside the toolset is refused, and the attempt
is still logged. See `docs/adr/0020`.

**Tool kind** — what a tool is *for*: read, edit, search, execute, plan, ask, delegate or computer.
What the pane and anything summarising a turn group by, so a new tool needs a kind rather than a
place in every reader.

**Plan** — the agent's visible checklist for the work in hand, replaced whole each time it changes
(`plan.updated`). Per turn, and unrelated to a **Job**, which is the durable objective; a plan is
how one turn says what it is doing about it.

**Plan mode** — a turn the person asked to plan rather than build. It may look (read, search,
questions, explore helpers) and nothing else, enforced when each call runs, and
it ends on a **proposed plan**. It opens no **Job** and commits nothing. Chosen per prompt by whoever
sends it, and carried on the prompt and its **turn request**, never a setting. The answer to a
**question** a plan mode turn asked is a plan mode prompt too. See
[ADR-0025](docs/adr/0025-plan-mode-proposes-and-the-next-message-decides.md).

**Proposed plan** — what a plan mode turn ends on (`plan.proposed`): a title and a Markdown body
for the person to approve. Not the **Plan** above, which is a checklist of work in flight; this is
written before anything changes. What became of it (*awaiting*, *approved*, *revised*, *superseded*,
or *interrupted* when its turn failed) is stored nowhere: it is whatever the next message did,
folded by `@nap/shared/plan-mode` for the chat pane and the runtime alike.

**Approval** — a prompt that names the plan mode turn whose plan it approves. It opens the job that
carries the plan out, named for the plan, and the plan rides in the turn context of every turn of
that job. An approval of a plan that is no longer awaiting builds nothing, and settles nothing
either. If the approving turn fails, the plan is awaiting again unless a newer request has replaced it.

**Steer** — a message somebody sends while a turn is running on their session, which joins that
turn rather than queueing one behind it: the agent reads it at its next step boundary, and the log
records it there (`steer.applied`). Not a **turn request**, though one with the same id stands in
for it when the turn ends without reading it — it is then simply the next turn. A turn that was
stopped, or whose worker died, runs none of its unread steers; each is offered back
(`steer.dropped`). Admitted and charged exactly as a prompt is. See
[ADR-0028](docs/adr/0028-a-steer-joins-the-turn-and-the-row-decides-where-it-lands.md).

**Step boundary** — the only place a turn takes anything new in: between model calls, once the last
batch of tool calls is answered in its one message, or when the model has stopped with room still to
answer. Never during a batch, so a steer never separates a tool result from its call.

**Skill** — a folder in the project holding a `SKILL.md`: frontmatter naming it and saying in one
line when it applies, then instructions for that kind of work, plus any files they refer to. The
agent is shown only the names and descriptions, in the **turn context**, and loads one with the
`skill` tool. Project guidance, below Nap's own instructions, and never a grant: its
`allowed-tools` can only narrow what the turn already had. Found under `.nap/skills/`,
`.agents/skills/` or `.claude/skills/`; a malformed, duplicate or oversized one is **skipped** with
its reason. See [ADR-0029](docs/adr/0029-skills-are-listed-loaded-on-demand-and-only-ever-narrow.md).
_Avoid_: rule (directory rules are `AGENTS.md` or `CLAUDE.md` files, read when a tool touches
their folder), prompt.

**Question** — a multiple-choice question the agent ends its turn on (`agent.question`). Its answer
is not a field anywhere: it is the person's next message, whether they clicked an option or typed.

**Helper** — a second, smaller model loop a turn hands one self-contained task to, with its own
conversation and fewer tools: *explore* reads and searches, *general* may also edit and run
commands. It spends the turn's budget, ends with the turn, and leaves only its start, its file
changes and its report in the log. Offered to imported repositories. Called a subagent in the code
(`run_subagent`), which is the same thing.

**Model line** — a family a vendor keeps shipping versions of (Sol, Opus, Muse Ember), and what a
person picks in the composer. A turn runs the line's **version**: the newest exact model id
OpenRouter lists for it that passes the shape check (`@nap/shared/model-lines`), unless the
deployment pins one. The line is the choice; the version is a fact about the catalog this hour, and
it is the version that is queued, billed and logged. Not to be confused with the free tier's model,
which a deployment names exactly and which belongs to no line. **Effort** is chosen beside it, per
turn.

**Background shell** — a command started to keep running, read and typed into and stopped by id
over later calls. Its state lives in files inside the sandbox, so it outlives the turn and the worker
that started it, and dies with the sandbox.

**Sandbox** — the isolated machine a project's code is written into and served from. Reclaimable at
any time, by the reaper or by the provider's own timer, which is why no view may treat "there is a
`preview.ready` in the log" as "something is running".

**Sandbox reservation** — a row claiming one slot of the deployment's sandbox ceiling, taken before
the sandbox exists and released when it stops existing. *Reserved* while the provider is being
asked, *active* once there is a sandbox to name; both occupy capacity, because a creation in flight
has already been paid for. It is the authoritative ceiling — the count the API route does at
admission is a cheap refusal and nothing more. Never called a quota: a quota is what a route
answers with, a reservation is what a slot *is*. A sandbox whose reservation was reclaimed while it
was being created is **uncounted** — running and billed, with no row holding a slot for it — which
is the one state the ceiling cannot see, and why it is destroyed rather than kept.

**Turn allowance** — how many turns one person may start inside a rolling hour, counted as one row
per *accepted* turn in `turn_rate_events`. Sliding rather than fixed, so `Retry-After` is the exact
moment the oldest row leaves the window; a refused attempt records nothing, so a retrying client's
recovery never recedes. There are two of them, told apart by *tier* — *free* for turns this
deployment pays for, *paid* for turns billed to whoever brought a key — and they are never one
shared count. An allowance is what a person may spend; a *ceiling* is what the deployment may run
at once. Different words for different limits, deliberately.

**Reconciliation** — the reaper's second job, on the same tick as the sweep: putting back capacity
no ordinary path gave back. Three things it finds — a reservation whose process died before it
created anything, a reservation whose sandbox the provider has since reclaimed, and a sandbox the
provider is running that nothing in the database references. Only the third destroys anything, and
only outside a grace window, because a sandbox seconds old and referenced by nothing is far more
likely to be a creation in flight than a leak. Rereading a GitHub pull request is a **PR refresh**,
never reconciliation.

**Put away** — a project whose sandbox has been destroyed on purpose, its work preserved in a
snapshot. Not an error and not an empty project: its files are safe, and starting it back up takes
seconds. The state a project spends most of its life in. Opening one starts nothing: it shows the
last snapshot until a message or **Resume** starts it (ADR-0037).

**Phase** — what a project is doing right now, as one named answer: *opening*, *idle*, *starting*,
*running*, *put away* or *failed*. Reconciles three sources that each know something the others
cannot — the record, the log, and a request in flight — in a fixed precedence. One function decides
it (`projects/project-phase.ts`); every pane draws it. Not to be confused with the record's own
`status` column, which is one of its inputs — nor with a **Job**'s phase, which answers a different
question about a different thing: this one is whether the project is *running*, that one is how far
the work has got.

**Snapshot** — the archived filesystem of a put-away project; what a restore rebuilds from.

**Dependency archive** — what a restore's own install left, stored beside the project's snapshot under a key of exactly what decided it: its `node_modules`, or, when the install ran lifecycle scripts or read local packages, the packages Bun downloaded, which a later restore installs from offline. A cache, never a source of truth: a restore uses it only on an exact key match and installs on anything else. Not part of the *snapshot*, which holds only what git does. See ADR-0032.

**Thumbnail lane** — where a project's dashboard picture is taken, after the turn that asked for it
has given its lease back. Best-effort and bounded by dropping: a picture that is late, skipped or
kept from the turn before is a stale card and nothing more. It never keeps a sandbox alive or makes
a session *busy*. See ADR-0022.

**Preview** — the user's app, running in a sandbox and reachable at a URL announced by
`preview.ready`. The `seq` of that announcement, not its URL, is what identifies *which* preview:
a project put away and restarted has two announcements and only one live sandbox.

**Computer** — the desktop inside a project's sandbox, behind `SandboxDesktop`. The agent sees
JPEG screenshots and sends batched input and observation actions through the `computer` tool.
Screenshot events name stored objects; the model receives images only within its active turn.
Desktop lifecycle and stream credentials stay separate from sandbox lifecycle and event storage.
See [ADR-0018](docs/adr/0018-the-agent-gets-a-computer.md).

**Input scope** — one single-use ownership of a project's Computer input, reserved durably before physical dispatch. A model attempt reserves lazily and an owner batch reserves once. Unknown completion retains the project's admission fence until a matching remote drain proof clears it. Closing a scope permanently revokes delayed input for that identity. Recovery never replays input or destroys source.

**Abandoning a Computer** — the owner's way out when a held input scope's machine never proves its drain. After one more drain attempt fails, the reservation is deleted and the project forgets that machine. The next turn restores the last snapshot onto a fresh one. This is not *closing* a project, which snapshots first: abandoning takes no snapshot of the machine it gives up, since all it has established is that the drain failed. Changes since the last snapshot are lost, including the work of a turn that completed and committed but never reached its snapshot, and every session of the project gets a notice in its log saying the computer was abandoned.

**Installation** — one GitHub App installation on a personal account or organization, bound to the
one Nap owner who connected it; what the UI calls a **GitHub connection**. It stays reserved to that
owner across a disconnect. Only GitHub answering 404 for it marks it *removed*; a rate limit or an
outage changes nothing stored. See `docs/github-integration.md` and `docs/adr/0033`.

**Repository job** — the GitHub side of a **Job** in an imported project: its `nap/<job-id>` branch,
base and head commits, the commit it pushed, and its pull request. A row in `repository_jobs`, keyed
by the Job's id; it records where the work went, while the Job itself still says how far it got.

**Publication** — pushing a repository job's *verified* commit to its branch and opening, or
finding, its draft pull request. Never a force-push, and never from an unverified commit. It runs
under the session's lease, either at the end of a job when the import chose to publish
automatically, or as a queued turn request of kind `publish` that spends no model tokens.

**PR refresh** — rereading one repository job's pull request — its state, checks, reviews and
comments — and writing down what it found, including **PR feedback**. A webhook delivery triggers
one, approving PR feedback rechecks with one first, and a pull request nothing has refreshed for
five minutes gets one from the backstop. Not
**reconciliation**, which is about sandbox capacity.

**PR feedback** — a failed check, or a `/nap <instruction>` comment from the connected GitHub user,
found by a PR refresh and held as *pending* until the Nap owner approves it. Approval turns it into
an ordinary turn request; nothing a webhook brings in ever starts one by itself.

**Webhook inbox** — the table signed GitHub deliveries are written to by the API and read from by the
**GitHub sweep**: deduplicated by delivery id, claimed under a lease, given up after five attempts.
Receiving a delivery and acting on it are separate on purpose, so an API pod never calls GitHub
on a webhook's behalf.

**GitHub sweep** — a third timer in the reaper process, every 15 seconds and behind the **sweep
lock**: it works through the webhook inbox, then gives a bounded number of stale pull requests a PR
refresh. Started only in the reaper (or `all`), and only when a GitHub App is configured.

**API proxy path** — `/backend` on the web app's own origin, which Vercel forwards to the API with
the prefix stripped. `NAP_API_URL` is this public address, so the session cookie is first-party.
Not the API's own host, which only the event stream (and webhooks) still reach directly.

**Stream ticket** — a one-minute signed proof of who is opening one session's `/ws`, issued over the
**API proxy path** where the cookie is sent, and carried in the socket's query string to the API's
own host, where it is not. Not a session: it is worth nothing on any other route.

## NapBench terms still in use

NapBench, the benchmark retired on 2026-11-17, keeps its glossary in
[`docs/NAPBENCH.md`](docs/NAPBENCH.md#glossary); these of its terms stay here because live code,
ADRs or the public-benchmark glossary below still use them, and a bold word they use that is not
defined in this file is defined there.

**Task** — one reproducible unit of work put to the agent: an id, a prompt or short sequence of
prompts, an environment that may seed files before anything runs, and the checks that decide whether
it worked. Declarative and independent of how Nap is built, so the same task can be pointed at a
different model, prompt or context engine without being edited. Tasks are the fixed thing in the
benchmark; everything else is a variable. **This word collides**: a NapBench task is a
specification of work to be repeated, where the runtime's unit of actual work being done once is a
**Job**. The two are different concepts and keep different names rather than one being renamed.

**Run configuration** — what a run was *held at*, as opposed to what it spent: which model ran, and
the ceilings the turn was given. The counterpart to the trajectory's model, which prices what was
*consumed* — two facts that usually share a value and must not be collapsed, since a run whose
configuration and consumption disagree is exactly the one worth reading. Absent on a report written
before it was recorded, which is *unrecorded* rather than *none*: a comparison refuses two runs held
at different budgets and deliberately does not refuse one it cannot tell about, because the second
rule would make the whole archive incomparable. See `docs/adr/0004`.

**Harness identity** — which Nap produced a run: the commit it was running at, whether that tree was
modified, and whether verification was on. Part of the run configuration, because ADR-0004 fixed the
frame as *the model, with Nap held fixed* and V2 moves Nap — without it, comparing a pre- and
post-verification run repeats the configuration-versus-consumption collapse one level up. **This
word collides, twice over**: NapBench is itself "the evaluation harness", and `bun run harness`
drives one turn. Here it is the *system under test*, named from the outside; the three keep their
names rather than one being renamed. Unrecorded on a report written before V2 and on any run from
outside a checkout, which is never read as a difference. A **Comparison** reports a differing
harness and, alone among the things it can see differ, does not refuse one.

**Run** — one execution of one task against one configuration, from a fresh session to a scored
report. The unit that has an id, a status, a score and a trajectory. **This is the word that
collides.** A NapBench *run* contains a Nap *session*, which contains one or more Nap *turns* — a
run is strictly the outer thing, and a task with two prompts is one run of two turns. Never say
"run" for a turn, and never say "session" for a run; the report's `runId` and the event log's
`sessionId` are different identifiers for different scopes and both appear in the same JSON.

**Trajectory** — how the agent got there, as opposed to whether it arrived: the run's events and the
metrics derived from them — tool calls, tool failures, commands, files touched, turn lifecycle,
token usage. Preserved whole, because the interesting question about two models with the same score
is what they did differently. Derived entirely from the existing event stream; anything the stream
cannot supply is absent rather than inferred. **Stored as two files, not one:** the events go in a
trajectory file and the metrics in the report beside it, because the metrics are what everything
reads and a second copy next to the events could disagree with the first.

**Product half** — the half of a score that asks whether what was built is a product anybody would
want to use, as against the **Objective half**, which asks whether it does what was asked. Graded
by a judge from **Surface** screenshots and the **Intent**, and combined with the objective half
*geometrically*, so neither can carry the other: correct-and-ugly lands in the forties rather than
the eighties. Absent when nobody judged, or when a judge looked and had nothing to see — and
absence renormalises to the objective half alone rather than multiplying by zero, per ADR-0002.
Which arithmetic produced a run's number is recorded on the report as its **scoring model**, `v1`
or `v2`, and `compare` refuses to put one beside the other: the scale is the same and the meaning
is not. See `docs/adr/0012` for the arithmetic, and `docs/adr/0013` for how the grades are reached.

**Trial** — one **Run** as an external harness sees it: the same execution, given a directory of its
own and named by the harness rather than by us. The word is the harness's and is kept because the
scopes are not identical — a run that ends in a report is a trial that ends in a report *and* a
verdict on whether that report is worth a **Reward**. Always one task; fan-out across tasks belongs
to the harness, since a trial covering four would produce four reports and one reward.

**Job directory** — where a trial's artefacts go, under fixed names: `report.json`,
`trajectory.json` and `trial.log`, with the reward written elsewhere by the verifier. The report is
written **on every trial, measured or not** — a trial the benchmark itself crashed on gets an
evaluator-error report — because a directory holding nothing is indistinguishable from a trial that
never started.

**Reward** — a run's report projected into the numbers an external harness understands: named
metrics on a 0–1 scale, `overall` beside the halves and the categories. A *projection*, and a lossy
one on purpose: it exists beside the report, never instead of it. A run that measured nothing yields
**no reward at all** rather than a zero — see the reward rule in `docs/NAPBENCH.md`.

**Route** — what the agent *did* on the way to a result, as opposed to how long it took: tool calls,
tool failures, commands run and files touched. The distinction is load-bearing for the claim
"same score, different route", which is about two runs doing different things. Duration and token
counts are reported beside it and deliberately excluded from deciding it, since both vary between
two runs that did identical work.

## Public-benchmark glossary

Terms for measuring Nap's agent on benchmarks somebody else wrote (Terminal-Bench, under Harbor),
where the tasks and their hidden tests are fixed and only the agent varies. See `harbor/README.md`.

**Task set** — a locked list of a public benchmark's task ids, drawn once from the whole dataset by
a seeded shuffle and committed before any scored run. **Test** is the set a reported score comes
from and nothing is tuned against; **dev** is disjoint from it and is where a change is tried
first. A different draw is a new set, and its scores do not compare with the old one's.

**Claimed done** — a trial whose turn ended `turn.completed`: the agent stopped and handed back,
which is the model's claim of done (see **Turn**). Set against the hidden tests' reward, it says
how often Nap's own "done" can be believed. Nothing reads the agent's prose, so a turn that
completes by saying it failed still counts as a claim.

## Load-generation glossary

The vocabulary of the load harness. Kept separate for the same reason NapBench's is: it describes
something *driving* the system rather than anything a user encounters. See
`docs/scaling-design.md` §23.

**Journey** — one scripted user's whole path through the system, start to finish: sign in through
the demo door, create a project, open a socket, wait to be told the replay is over, submit a turn,
read frames until `job.completed`. The unit a load run is made of — a hundred concurrent users is
a hundred journeys, not one journey repeated. A step that fails ends the journey, because a turn
that was never admitted has no duration worth reporting.

**Calibration** — how slow the fakes pretend to be, and where those numbers came from. Every
figure is from a funded run recorded in `docs/napbench-*.md`, never chosen to make a run finish
sooner: instant fakes would complete each turn before the next user connected, and nothing would
ever be concurrent. **This word is not a synonym for configuration** — a calibration figure
changes only when another funded run records something different.

**Threshold** — one condition a run is held to, as a metric, a statistic of it, a comparison and a
number. A threshold whose metric was never recorded **fails**, rather than passing vacuously: a
harness that quietly stopped measuring something must not report a green run.
