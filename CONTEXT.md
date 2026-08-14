# Context

The words this codebase uses for the things it is about, so that one concept has one name. Added
to when a term actually gets resolved rather than upfront — see `docs/agents/domain.md`. What v1
*is* lives in `docs/PLAN.md`; why the code is shaped the way it is lives in `docs/GOTCHAS.md`.

## Glossary

**Project** — what a user is building: a name, an owner, files, and at most one sandbox serving it
at a time. Outlives every sandbox it ever had.

**Session** — one conversation about a project. A project's newest session is the one its workspace
opens; a link never names a session, because the project grows new ones.

**Turn** — one exchange within a session: a user message, whatever the agent does about it, and
exactly one terminal event (`turn.completed` or `turn.failed`). The unit budgets, cancellation and
commits are all scoped to.

**Event** — one durable, ordered fact about a session, identified by its `seq`. Appended to the
store *before* it is published to the bus, never the other way round.

**Session log** — the ordered, append-only run of a session's events *as a client holds it*: one
socket, one `seq`, many derived views. Distinct from the `EventStore`, which is where events live;
the log is one reader's copy of them. In the browser it is `useSessionLog`, and there is one per
workspace — a second one is two clients that can disagree about what the newest event was.

**Sandbox** — the isolated machine a project's code is written into and served from. Reclaimable at
any time, by the reaper or by the provider's own timer, which is why no view may treat "there is a
`preview.ready` in the log" as "something is running".

**Put away** — a project whose sandbox has been destroyed on purpose, its work preserved in a
snapshot. Not an error and not an empty project: its files are safe, and starting it back up takes
seconds. The state a project spends most of its life in.

**Phase** — what a project is doing right now, as one named answer: *opening*, *idle*, *starting*,
*running*, *put away* or *failed*. Reconciles three sources that each know something the others
cannot — the record, the log, and a request in flight — in a fixed precedence. One function decides
it (`projects/project-phase.ts`); every pane draws it. Not to be confused with the record's own
`status` column, which is one of its inputs.

**Snapshot** — the archived filesystem of a put-away project; what a restore rebuilds from.

**Preview** — the user's app, running in a sandbox and reachable at a URL announced by
`preview.ready`. The `seq` of that announcement, not its URL, is what identifies *which* preview:
a project put away and restarted has two announcements and only one live sandbox.

## NapBench glossary

NapBench is the evaluation harness that measures Nap's agent. Its vocabulary is kept separate
because it describes the thing *observing* the system, not the system — a user never encounters any
of these words. Where the two vocabularies collide, the collision is named below rather than
resolved by hoping nobody notices. See `docs/adr/0001`–`0003` for the decisions behind them.

**Task** — one reproducible unit of work put to the agent: an id, a prompt or short sequence of
prompts, an environment that may seed files before anything runs, and the checks that decide whether
it worked. Declarative and independent of how Nap is built, so the same task can be pointed at a
different model, prompt or context engine without being edited. Tasks are the fixed thing in the
benchmark; everything else is a variable.

**Check** — one acceptance criterion, and the only thing a score is ever made of. Four kinds:
*command* (run something in the sandbox), *browser* (drive the preview and assert), *accessibility*
(axe against a rendered page), and *custom* (the extension point). Every check carries the category
it scores into, a weight, and whether it is required. A check produces exactly one of *passed*,
*failed* or *absent* — and the difference between the last two is load-bearing, see **Gate**.

**Category** — which axis of quality a check speaks to: *functional*, *browser*, *visual* or *code*.
Weighted into the overall score, and the weighting renormalises over the categories that actually
produced results. A check's category defaults from its kind and can be overridden by the task,
because `npm run build` and `npm run lint` are both commands and are not both functional.

**Gate** — a rule that constrains the outcome regardless of what the checks summed to: a failed turn
is an error with no score, a preview that never serves fails the run, a failed required check fails
the run, a build failure fails it and caps the overall score. Gates exist so a broken application
cannot score well by being good at everything except working. They are an ordered list of pure
functions, each individually tested.

**Status** — how a run ended, as one of four answers. *Passed* and *failed* are results, and both
have a score. *Errored* means no result was obtained, so there is no score to give. *Cancelled*
means somebody stopped it, which is not an observation at all.

**Error kind** — whose fault an errored run was: *agent*, *model*, *sandbox*, *browser*,
*evaluator* or *configuration*. The distinction is what keeps a benchmark honest — an agent that
refused and a provider outage both produce no score, and only the first is evidence about the agent.
Suite reporting keeps agent-attributable and infrastructure-attributable error rates apart for that
reason.

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
cannot supply is absent rather than inferred.

**Suite** — a named set of tasks run together, and the level at which a model is characterised
rather than a single result observed. Reports a mean over completed runs beside an explicit error
rate, because a run whose turn failed has no score and would otherwise vanish from the average.
