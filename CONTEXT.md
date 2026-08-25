# Context

The words this codebase uses for the things it is about, so that one concept has one name. Added
to when a term actually gets resolved rather than upfront — see `docs/agents/domain.md`. What v1
*is* lives in `docs/PLAN.md`; why the code is shaped the way it is lives in `docs/GOTCHAS.md`.

## Glossary

**Project** — what a user is building: a name, an owner, files, and at most one sandbox serving it
at a time. Outlives every sandbox it ever had.

**Session** — one conversation about a project. A project's newest session is the one its workspace
opens; a link never names a session, because the project grows new ones.

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
to decide in advance which it is. **Not NapBench's `Task`**, which is a specification of work to be
repeated; a job is one actual piece of work being done once. See `docs/adr/0006`.

A job is *working*, *verifying* or *repairing* while it is open, and once closed its phase is how it
ended: **verified** (checks passed, so the commit is a checkpoint), **unverified** (the turn changed
no files, so there was nothing to check — not a failure and not a success), **exhausted** (three
repairs spent with checks still red) or **abandoned** (the turn it was riding on was cancelled or
refused). `foldJobs` in `@nap/shared` is the one function that decides all of it.

**Verification** — what the system finds, as against what the model claims. A turn that changed the
workspace is committed and then checked: the project's own checks, cheapest first, stopping at the
first failure. Passing makes the commit a **checkpoint**; failing opens a repair turn carrying the
failure. Bounded by attempts rather than by a token ledger, and confined to sandbox commands and a
preview probe — the browser stays NapBench's alone, per `docs/adr/0001`.

**Check** — one command, run in the sandbox, that passed, failed, or was **absent**. Absent is not
failure and the gap is load-bearing in both directions: a project with no `test` script has not
failed its tests, and treating a missing script as a failure would put every fresh project into a
repair loop it cannot leave. Which checks exist is discovered from the project rather than declared
by the model. Owned by `@nap/verify` and shared with NapBench, which adds scoring metadata to it —
see the NapBench **Check** entry, and `docs/adr/0007`. The passed/failed/absent triple itself sits
one layer lower still, in `@nap/shared`, because `verification.completed` carries it into the log.

**Verdict** — what a whole *run* of the checks came to, as against the outcome of any one of them:
**passed**, **failed**, or **errored**. The third is the one worth the word. Failed is the project's
and opens a repair turn; errored means nothing was learned about the project — the sandbox refused
the command, or the preview listens inside and is unreachable from outside — and a repair turn on
that would ask a model to fix a machine it cannot see, so its checks come back *absent*. **An
errored run is never written as a verification.** `verification.completed` carries checks and no
verdict on purpose, and an all-absent payload folds to `verified`; the job ends **abandoned**
instead. `runChecks` in `@nap/verify` is where a verdict comes from, and it is branched on before
anything is persisted rather than persisted itself.

**Job brief** — the `<job>` section of the assembled prompt: the job's **objective**, and the
verification failures already seen on it, oldest first. The second half is procedural memory done
deterministically — a transcript shows the model confidently finishing, never that the finish was
rejected, so without this each repair is free to make the last one again. Near-unevictable, and
that is the point: the situation it exists for is a long repair with a full context, which is
exactly when the turn that stated the objective has fallen out of the window. Handed to the
`ContextEngine` like `history` is, because the component that owns the token budget performs no
I/O. `renderJobBrief` in `@nap/context` writes it.

**Stale** — of a past turn in the assembled conversation: old enough that its tool traffic is
emptied whether or not the budget needs the room. What survives is prose on both sides and each
call's small arguments — which tool, against which path — so the turn still reads as something that
happened; what goes is any argument large enough to be a file's contents, and everything the call
printed. Distinct from **truncation**, which is the ladder `ContextEngine` climbs when a context
does not *fit*: staleness runs first and runs always, because a turn re-sends its whole transcript
on every round trip and a thing that fits can still be a thing not worth ten copies. See ADR-0011.

**Checkpoint** — a *verified* commit, and the answer to "is this project in a valid state right
now", which is `HEAD == last checkpoint` rather than a judgement anybody renders. Distinct from a
**Snapshot**, which is a filesystem archived because a sandbox went away: a checkpoint is about
whether the work is sound, a snapshot about where the work is kept. Every completed turn commits;
only a verified one checkpoints, which is what makes a failed verification unable to corrupt the
last known-good state by construction rather than by care. **The word keeps that strength in the
UI**: the panel behind the job strip is a history of *jobs*, failures included, because a list of
checkpoints is a list with every failure deleted from it — "Checkpoint" appears only against a sha
a verification agreed with, on the line inside a history entry (`apps/web/src/chat/job-history.tsx`)
and on the card that says what was decided in your absence (`apps/web/src/chat/unseen-card.tsx`).

**Unseen** — the events in a session that *this browser* has never displayed, computed against a
persisted **seen cursor**: `localStorage`, keyed by session, advanced only while the document is
visible. Deliberately not "away" — away names the user's state, which nothing can observe, and
what is computed is a property of the log against a cursor; "While you were away" is copy and may
differ. **Distinct from the replay `seq`** that `use-event-stream.ts` keeps and `/ws?seq=N`
resumes from, which is per-connection and in memory where this is per-browser and durable. Two
cursors, two lifetimes, and they must not share a word or somebody eventually persists the wrong
one. The **seam** is where the two meet on screen: a line through the transcript with everything
below it unseen, and where the transcript opens (`apps/web/src/chat/unseen.ts`).

**Continue** — what happens to an open job when its project is next opened, as distinct from
**resume**, which already means bringing a put-away project's sandbox back up (`resumeSession`). A
process restart leaves a job open rather than failing it; nothing continues a job while nobody is
watching.

**Turn request** — a durable, queued intent to execute, and one row in `turn_requests`. Created by
an API pod at admission, claimed by exactly one worker, terminal exactly once — *queued*, then
*leased*, then one of *done*, *failed* or *orphaned*, with **no path back to queued**. Its *kind* is
`turn` or `resume`. **Not a Job**: a job is one objective folded from the event log, and one request
may drive a job through several turns — the prompt and its repairs. It carries *whether* the asker
pays, never their key, so no credential is ever in that table. A request is claimed at most once,
which is what makes queue delivery at-least-once and logical turn execution at-most-once.
**Its id is also the turn id of the first Turn it becomes**, allocated at admission before the row
is inserted — which is how the janitor, on a pod that never ran the turn, can close out the right
one. A *repair* is a distinct Turn with an id of its own: it shares the request's lease, not its
identity. Why the queue is a table rather than a broker is `docs/adr/0009`.

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
the request *orphaned* and writes the terminal event the interrupted Turn never got, under the
request's own id. **It never requeues and never closes the Job**: re-executing with nobody watching
is what *Continue* forbids, so the work waits for a human to reopen the project.

**Role** — which part of the deployment a process is: an **API pod** serves HTTP, WebSockets, auth
and admission and executes nothing, a **worker** claims leases and executes turns and serves
nothing, and the **reaper** runs the periodic sweeps and does neither. All three are the same
composition given a different role, so it names a *process's job* and never a build, an image or a
code path. `all` is the three in one process, which is what tests and the load harness compose.

**Sweep lock** — what makes the reaper one sweeper rather than one replica. A session-level advisory
lock, asked at the top of every idle-sweep tick and held on a connection of its own; a process that
does not hold it does nothing that tick. It exists for the seconds of a rolling update when two
reapers are running, and it guards the idle sweep alone — the **janitor** beside it is safe to run
twice over and deliberately unguarded.

**Busy** — whether any of a project's sessions holds a *lease* right now. One question with one
answer for the whole cluster (`TurnQueue.anyLeased`), asked by closing a project, deleting one, and
the idle sweep. It is a **filter, not a lock**: it describes the instant it was asked, and a turn
starting immediately afterwards loses its sandbox and is restored from the snapshot the sweep just
took. Holding a lock across a teardown instead would let a wedged sweep block turns.

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
likely to be a creation in flight than a leak.

**Put away** — a project whose sandbox has been destroyed on purpose, its work preserved in a
snapshot. Not an error and not an empty project: its files are safe, and starting it back up takes
seconds. The state a project spends most of its life in.

**Phase** — what a project is doing right now, as one named answer: *opening*, *idle*, *starting*,
*running*, *put away* or *failed*. Reconciles three sources that each know something the others
cannot — the record, the log, and a request in flight — in a fixed precedence. One function decides
it (`projects/project-phase.ts`); every pane draws it. Not to be confused with the record's own
`status` column, which is one of its inputs — nor with a **Job**'s phase, which answers a different
question about a different thing: this one is whether the project is *running*, that one is how far
the work has got.

**Snapshot** — the archived filesystem of a put-away project; what a restore rebuilds from.

**Preview** — the user's app, running in a sandbox and reachable at a URL announced by
`preview.ready`. The `seq` of that announcement, not its URL, is what identifies *which* preview:
a project put away and restarted has two announcements and only one live sandbox.

## NapBench glossary

NapBench is the evaluation harness that measures Nap's agent. Its vocabulary is kept separate
because it describes the thing *observing* the system, not the system — a user never encounters any
of these words. Where the two vocabularies collide, the collision is named below rather than
resolved by hoping nobody notices. See `docs/adr/0001`–`0005`, `0007` and `0012`–`0013` for the
decisions behind them.

**Task** — one reproducible unit of work put to the agent: an id, a prompt or short sequence of
prompts, an environment that may seed files before anything runs, and the checks that decide whether
it worked. Declarative and independent of how Nap is built, so the same task can be pointed at a
different model, prompt or context engine without being edited. Tasks are the fixed thing in the
benchmark; everything else is a variable. **This word collides**: a NapBench task is a
specification of work to be repeated, where the runtime's unit of actual work being done once is a
**Job**. The two are different concepts and keep different names rather than one being renamed.

**Check** — a `@nap/verify` **Check** plus the scoring metadata that makes it an acceptance
criterion: the category it scores into, a weight, and whether it is required. The primitive — one
thing run, that passed, failed or was absent — is shared with the runtime's verifier, because it
was never NapBench's alone; what is NapBench's is that a score is made of nothing else. Three kinds:
*command* (run something in the sandbox), *browser* (drive the preview and assert) and
*accessibility* (axe against a rendered page). A fourth, *custom*, was specified and deliberately
not built: a task is **data**, validated by a schema as its module loads, and a custom check would
be code — which no schema can validate and no sandbox can be handed. The extension point the fourth
kind was meant to provide is the discriminated union itself: a new kind is a schema, a branch in the
executor's dispatch and a default category, which is exactly what adding *accessibility* turned out
to cost. Only *command* is the shared primitive; *browser* and *accessibility* are NapBench's own
and stay there, since ADR-0001 keeps the browser out of anything that ships. The passed / failed /
*absent* triple is the primitive's, and the difference between the last two is load-bearing here in
its own way — see **Gate**.

**Check output** — what a failed command actually said, kept on the check beside the exit code it
does not explain. Recorded only on failure and only when there was something to record, because a
passing build's output is churn in an artefact people diff. Each stream is budgeted on its own and
keeps its **tail** — a failing command prints its banner first and its reason last, and a shared
budget would let a chatty stdout push out the stderr that explains the failure. A stream says
whether it was truncated, so a fragment is never read as the whole.

**Step** — one line of a browser check: an *action* that does something to the running application
(navigate, click, fill, press, reload, select, resize) or an *assertion* that must hold at that
point. Actions and assertions are one ordered list rather than two, because almost everything worth
asserting is a change — the item that appears after the button, the list that shortens under a
filter, the thing still there after a reload.

**Arrival** — the opening navigation of a browser or accessibility check, as distinct from any
navigating it does later. Retried a few times before it is believed, and a failure that survives
every attempt is the *evaluator's* rather than the agent's: the preview gate has already proven that
URL serves, so a check that never gets there observed nothing about the application and must not
record a failed check against it. A `navigate` or `reload` *after* arrival is the opposite — the
road was demonstrably fine moments ago — and stays a failed check. See `docs/adr/0005`.

**Selector** — how a step names an element, as a value rather than a CSS string: by *role* (with an
accessible name), by *label*, by *text* or by *test id*. Nobody wrote the markup of a generated
application, so nobody can write a selector against it; these four are what a page *means* rather
than how it is built, and they are answerable by a fake.

**Viewport** — the size a browser check runs at, as one of three names — *mobile*, *tablet*,
*desktop* — defaulting to desktop. A field on the check rather than a kind of its own, so the same
sequence can be asserted at two sizes without being written twice.

**Category** — which axis of quality a check speaks to: *functional*, *browser*, *visual* or *code*.
Weighted into the overall score, and the weighting renormalises over the categories that actually
produced results. A check's category defaults from its kind and can be overridden by the task,
because `npm run build` and `npm run lint` are both commands and are not both functional.

> **`visual` is the v1 name and is superseded.** It was a category with a port behind it and no
> implementation, and how an application looks is now the **Product half**, graded on
> **Dimension**s by a **Judge**. The name is kept rather than removed: every archived report names
> it in its category list and its effective weight vector, and deleting it would make those files
> unreadable by the code that wrote them. Nothing new scores into it — a task written today gets
> the product half instead — so on any recent report it is simply absent, which renormalises. See
> `docs/adr/0012`.

**Dimension** — one axis the **Product half** is graded on, and deliberately not a **Check** and
not a **Category**. A check asks a question with a yes-or-no answer and is answered by a machine; a
dimension asks how good something is and is answered by a **Judge** on an ordinal scale. Two words
because they are two kinds of claim, and one word would let a judgement be read as a measurement.
There are nine — *hierarchy*, *typography*, *spacing*, *color*, *layout*, *components*,
*interaction*, *responsiveness*, *restraint* — equally weighted, because any weighting we chose
would be our own aesthetic theory compiled into the instrument. A tenth, *polish*, is the judge's
holistic read: reported, never scored, and structurally outside `PRODUCT_DIMENSIONS` so no fold can
pick it up. Its value is the *disagreement* — a holistic read far below the computed mean says the
rubric is missing a dimension. A dimension that could not be assessed is **absent**, exactly as a
category is, and renormalises rather than scoring low.

**Restraint** — the dimension that asks whether each visual decision earns its place, and where
icon usage is judged. Named for the question rather than for any of its answers: there is
deliberately **no icon dimension**, because naming one would bake a component library into the
rubric and make the benchmark measure adherence to our taste. A gradient, a rounded card, a shadow
and an icon each have to answer the same question, and each can be the right call — so this is not
a penalty list, and slop is not a rule. The rubric requires icon usage to be *stated* here on every
run, so it stays visible even when the answer is "fine".

**Judge** — whoever grades the **Product half**: a scripted judgement in a unit test, a vision model
behind `--real`, or a person filling in a form. A port (`ProductEvaluation`) for the reason
`BrowserSession` is one, so the scorer never learns how a judgement was made and the free path and
the paid path drive identical scoring code. Every judgement records the judge's *identity* — a
source and a **rubric version** — because the same model against a reworded rubric is a different
instrument, and a score taken under one is not a score taken under the other. It is shown
**screenshots and the Intent and nothing else**, and it arbitrates nothing: the gates fire before it
is consulted, so it can never rescue an application that does not work. See `docs/adr/0013`.

**Gate** — a rule that constrains the outcome regardless of what the checks summed to: a declared
starting state that could not be seeded errors the run before a prompt is ever sent, a failed turn
is an error with no score, a preview that never serves fails the run, a failed required check fails
the run, a browser that could not be started errors it without blaming the agent, a build failure
fails it and caps the overall score. Gates exist so a broken application
cannot score well by being good at everything except working. They are an ordered list of pure
functions, each individually tested.

**Status** — how a run ended, as one of four answers. *Passed* and *failed* are results, and both
have a score. *Errored* means no result was obtained, so there is no score to give. *Cancelled*
means somebody stopped it, which is not an observation at all.

**Error kind** — whose fault an errored run was, as one of seven answers in four groups: the system
under test (*agent*, *runtime*), what it depends on (*model*, *sandbox*), the instrument (*browser*,
*evaluator*) and the operator (*configuration*). The distinction is what keeps a benchmark honest —
an agent that refused and a provider outage both produce no score, and only the first is evidence
about the agent. **What is measured is the model, with Nap held fixed**, so the split does not ask
whose code was at fault but whether the failure says anything about a model: *agent* alone is
agent-attributable and the other six are infrastructure. *Runtime* and *evaluator* are the pair
worth keeping apart — Nap's own machinery breaking against NapBench crashing on itself — because a
suite full of the first is a deployment to fix and one full of the second is a benchmark to fix.
See `docs/adr/0004`.

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

**Surface** — a named view a task wants photographed, plus the steps that reach a state worth
looking at: an empty list, a populated one, a detail page. Declared rather than inferred, because
a **Check** is named for what it asserts and not for what it is looking at — so a check's
photograph cannot be cited as a view, and nothing about it guarantees the *pair* a judge needs.
Every surface is captured at **mobile** and **desktop**, which is what makes "was the small
viewport designed for, or the large one squashed" answerable at all. A task that declares none
still gets the default pair — `/` at both sizes — so no run ends with nothing to judge. Steps are
the browser-step vocabulary minus assertions and resizes: a surface is evidence, not a check, so
it has nowhere to put a failed assertion, and the size belongs to the pass rather than to the view.

**Capture pass** — the deliberate photography, run after every check has had its say and before
any judge is asked. One browser session per image, for the isolation reason a check gets one. It
changes no score on any path: an unreachable surface, an absent browser and a full disk each cost
the run an image and nothing else. Bounded at four surfaces a task, so at most eight images —
every one of them is vision-model tokens on a real run.

**Screenshot** — a picture of the running application, of **exactly one** of two things: a
**Check**, taken at the end of one at the viewport that check *actually finished at* rather than
the one it declared, since a check may resize partway through; or a **Surface**, taken by the
capture pass because somebody asked for that view at that size. Only the second is comparable, and
only the second is put in front of a judge. Never stored alone: each image has a sidecar naming the
task, run, whichever of the check and the surface it is of, size, moment and reference, so an image
copied out of the results directory still says what it is.
Referenced from the report by a path **relative to the results directory** — an absolute one is
wrong the first time somebody moves the directory. Evidence *about* a run rather than an
observation *of* the application, which is why a screenshot that could not be taken or stored
degrades the report and never changes a score.

**Visual evaluation** — *v1, superseded by the **Product half**.* What a judge made of how the
application looks, as one of two answers: *not run*, or a *score* with a `source` naming who
produced it. It never answered anything else — the port shipped with two trivial implementations
and a `not_run` default, so the `visual` **Category** was weighted 15 and never once produced a
number. What replaced it grades nine **Dimension**s ordinally and multiplies rather than averaging,
because a single number for "how it looks" carried at 15% could always be bought by correctness.
The word stays in the glossary for the reason the category does: archived reports use it.

**Intent** — one neutral sentence saying what an application is *for*, declared by a task and the
whole of what a product judge is told about it. Never the prompts: a person opening the finished
application has no specification, and a judge shown the prompts would start grading feature
completion, which the checks already measure and measure better because a check cannot be talked
round. It is also the switch — a task that declares one is scored on two halves, and a task that
declares none is scored on its checks alone whatever judge is composed, which is what keeps the
frozen `all` suite priced as its funded runs priced it.

**Objective half** — the half of a score that asks whether the application does what was asked, as
against the **Product half**, which asks whether anybody would want to use it. It is the v1
four-category weighted mean, unchanged and still renormalising: **the arithmetic of the objective
half is exactly the arithmetic of a v1 score**, which is what lets the frozen `all` suite go on
being priced as its funded runs priced it. Deterministic in the strong sense — every number in it
comes from a **Check** that ran, and no judgement of any kind reaches it. It is also the half that
can stand alone: a run nobody judged is scored on this and nothing else.

**Product half** — the half of a score that asks whether what was built is a product anybody would
want to use, as against the **Objective half**, which asks whether it does what was asked. Graded
by a judge from **Surface** screenshots and the **Intent**, and combined with the objective half
*geometrically*, so neither can carry the other: correct-and-ugly lands in the forties rather than
the eighties. Absent when nobody judged, or when a judge looked and had nothing to see — and
absence renormalises to the objective half alone rather than multiplying by zero, per ADR-0002.
Which arithmetic produced a run's number is recorded on the report as its **scoring model**, `v1`
or `v2`, and `compare` refuses to put one beside the other: the scale is the same and the meaning
is not. See `docs/adr/0012` for the arithmetic, and `docs/adr/0013` for how the grades are reached.

**Fixture corpus** — nine hand-written applications, committed as pages plus photographs, that a
judge has to be able to tell apart. Nine designs of *one* application with one shared **Intent**, so
design is the only variable between two of them. It is not a benchmark task and never runs: nothing
is generated, no sandbox is acquired and no score reaches a report. It exists because an evaluator
nobody has watched discriminate is a check that has never been observed failing.

**Discrimination expectation** — one claim about what the corpus's grades must *do*, in one of
three shapes: a **pair ordering** on one dimension (minimalist grades better than slop on
`hierarchy`), a **margin** between two whole product scores (broken-beautiful beats correct-ugly by
at least a real margin), or a **grade bound** (`responsiveness` on desktop-only-breaks-mobile is at
most `weak`). Never an absolute score — that would be *assert on model prose* in numeric form. Each
is one half of a pair, so passing it requires telling two fixtures apart rather than marking one
thing down everywhere. A margin is the shape for a pair built to differ in everything a photograph
shows, and there is only one such pair; a pair built to differ in three places is three orderings.
Its three outcomes are **met**, **unmet** and **not assessable**; the third is absence, which is
neither, for the reason the **product half** renormalises rather than scoring zero.

**Reference screenshot** — what a browser check's screenshot is *meant* to look like, as a path the
task declares. Nothing compares against it yet; it is expressible now so that tasks can carry
references before the judge that reads them exists. Declared per check rather than per task,
because one task routinely photographs several viewports.

**Suite** — a named set of tasks run together, and the level at which a model is characterised
rather than a single result observed. Reports a mean over completed runs beside an explicit error
rate, because a run whose turn failed has no score and would otherwise vanish from the average.

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

**Spread** — what a task's repeated runs came to, as mean, median, sample standard deviation and
range. Reported **per task**, never across a suite: a deviation over different tasks measures how
much the tasks differ in difficulty, which is a fact about the benchmark rather than about the
model. A task run once has *no* standard deviation rather than one of zero — zero is a claim of
perfect consistency, and what happened is that nobody measured twice.

**Comparison** — two runs of the same task, and what moved between them: overall, per category and
per check. The **baseline** is what was, the **candidate** is what is; a candidate that scores
worse is a regression against that baseline and nothing else. Two runs, never three — three is a
table rather than a diff. **Refused** whenever the two effective weight vectors differ, because
renormalisation means a score is only meaningful relative to the categories that produced it; the
*configured* vector deliberately does not decide, since reweighting a category neither run scored
renormalises to the same vector and those runs are comparable. Refusal is skipped when either run
has no score: there is no number there to reprice, and refusing would make an errored run
incomparable with everything, which is when its counterpart is most worth reading. A differing
**Harness identity** is the one difference it reports rather than refuses.

**Check movement** — what happened to one check between the two runs: *fixed*, *broken*, *changed*,
*unchanged*, *added* or *removed*. `changed` is the one that earns its place: a check that went
absent is neither a regression nor a repair — the run never asked — but it renormalises its
category out and moves the score, so calling it unchanged would leave a moved number with nothing
explaining it.

**Route** — what the agent *did* on the way to a result, as opposed to how long it took: tool calls,
tool failures, commands run and files touched. The distinction is load-bearing for the claim
"same score, different route", which is about two runs doing different things. Duration and token
counts are reported beside it and deliberately excluded from deciding it, since both vary between
two runs that did identical work.

**Accessibility check** — a check kind that audits one rendered page with axe and fails on findings
at or above a grade the task declares, defaulting to *serious*. The bar is the design: failing on
every finding would fail essentially every generated application, which is a check that has stopped
separating them. An **ungraded** finding always counts — the tool reports only violations, so one it
declined to grade is still one, and guessing a severity for it would understate it. Scores into
*code* rather than *browser*, because a category is a property of what a check measures rather than
of how it measures it: the audit drives nothing and asserts no behaviour, and what it reports is the
quality of the markup.

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
