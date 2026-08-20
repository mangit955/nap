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

**Checkpoint** — a *verified* commit, and the answer to "is this project in a valid state right
now", which is `HEAD == last checkpoint` rather than a judgement anybody renders. Distinct from a
**Snapshot**, which is a filesystem archived because a sandbox went away: a checkpoint is about
whether the work is sound, a snapshot about where the work is kept. Every completed turn commits;
only a verified one checkpoints, which is what makes a failed verification unable to corrupt the
last known-good state by construction rather than by care.

**Continue** — what happens to an open job when its project is next opened, as distinct from
**resume**, which already means bringing a put-away project's sandbox back up (`resumeSession`). A
process restart leaves a job open rather than failing it; nothing continues a job while nobody is
watching.

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
answers with, a reservation is what a slot *is*.

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
resolved by hoping nobody notices. See `docs/adr/0001`–`0005` and `0007` for the decisions behind
them.

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

**Screenshot** — a picture of the running application taken at the end of a browser check, at the
viewport that check *actually finished at* rather than the one it declared, since a check may
resize partway through. Never stored alone: each image has a sidecar naming the task, run, check,
size, moment and reference, so an image copied out of the results directory still says what it is.
Referenced from the report by a path **relative to the results directory** — an absolute one is
wrong the first time somebody moves the directory. Evidence *about* a run rather than an
observation *of* the application, which is why a screenshot that could not be taken or stored
degrades the report and never changes a score.

**Visual evaluation** — what a judge made of how the application looks, as one of two answers:
*not run*, or a *score* with a `source` naming who produced it. Today it is always not run; the
interface exists so that a pixel comparison, a VLM judge or a person can be plugged in without
reshaping the result. **Not run is not zero** — an unevaluated visual category renormalises out of
the weighting per ADR-0002, so a run nobody judged is scored over what was measured instead of
being docked fifteen points for a judge that does not exist. And it is never the primary measure:
visual is 15 against functional's 50, and the build and preview gates cap or fail a run long before
this is consulted, so a broken application cannot be rescued by something thinking it looks nice.

**Reference screenshot** — what a browser check's screenshot is *meant* to look like, as a path the
task declares. Nothing compares against it yet; it is expressible now so that tasks can carry
references before the judge that reads them exists. Declared per check rather than per task,
because one task routinely photographs several viewports.

**Suite** — a named set of tasks run together, and the level at which a model is characterised
rather than a single result observed. Reports a mean over completed runs beside an explicit error
rate, because a run whose turn failed has no score and would otherwise vanish from the average.

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
