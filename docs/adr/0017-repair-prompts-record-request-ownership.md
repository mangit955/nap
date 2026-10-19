# ADR-0017: Repair prompts record request ownership

**Status:** Accepted design, verification pending, 2026-10-19.

A request can finish its first turn and continue through verification repairs under the same
lease. Closing only the request's first turn after worker loss leaves its active repair open.
Closing whichever turn appears last can instead interrupt a newer request, since another worker
can claim the session between orphaning and announcement. A job ID alone cannot distinguish the
original request's repairs from a later resume request continuing that job.

The runtime records `repair: { requestId, jobId }` on each synthesized `user.message` and drains
it before preparing context. The event's `turnId` identifies the repair, `requestId` identifies
the request holding its lease, and `jobId` identifies the objective it repairs. This relationship
is durable with the prompt, including the interval before `turn.started`. It requires no second
table, queue mutation or new event type. A separate ownership event would introduce another
partial-write boundary for the same fact.

The janitor reads the session history after orphaning. An ordinary request owns its initial
turn, even if preparation wrote nothing, and every repair prompt that names that request. A
resume request owns only the repair turns that name it; the open operation itself gets no turn
failure. For each owned turn without a durable terminal, recovery appends `turn.failed` under
that turn's ID. Existing successes and failures remain unchanged. The notice stays under the
request's ID, and the row is marked announced only after all these events drain. Read or append
failure leaves the row owed. A later tick checks the durable history again, including an append
whose acknowledgement was lost. Concurrent janitors can still append duplicate terminals; this
is not an exactly-once append guarantee. Activity remains a fold by turn ID, so those terminals
cannot end unrelated work and a repeated start cannot reopen an ended turn.

The transcript classifies a recorded repair before its agent starts. Retry looks up the user
prompt on the turn that opened its recorded job, preserving that prompt's media. When that
opening is missing from the replay window, no unrelated prompt is offered as a substitute.
Legacy transcript classification remains available for old logs. Preparation failures also end
the active repair on both ordinary and resume paths; the previous turn's terminal cannot stand
in for the repair's outcome.

The optional field lets new code read old logs. It cannot supply ownership that old workers
never recorded. A legacy repair can belong to the original request or to a later resume that
emitted no identifying event. Job identity, text, proximity and timestamps do not prove ownership.
The janitor never guesses an owner or backfills already-announced rows.

The UI instead reconciles activity through `GET /sessions/:sessionId/activity?cursor=N`. After
checking session ownership, the API reads the durable tail including row N, then asks
`TurnQueue.hasPending` whether the session has queued or leased requests. The response is
`{ sessionId, throughSeq, active }`, with `Cache-Control: no-store`. N must exist when nonzero;
an ahead-of-history cursor is refused. The returned boundary comes from the store, not the caller.
With cursor zero the read covers all history. Subsequent reads normally fetch one cursor row and
any newer events. This uses the existing event store and queue, with no second durable state.

The read order matters. An idle queue observation can retire activity only in the prefix read
before it. An admission after the queue read cannot have produced an event in that prefix.
Anything later in the log is still folded by turn ID, and terminal IDs from the whole log still
prevent duplicate starts from reopening ended work. No terminal or ownership fact is invented,
no transcript row is removed, and the Job and its cumulative budgets remain unchanged.

The submission hook owns one activity loop and supplies both `running` and `startedAt` to the
pane. It polls one second after the preceding read finishes, with a five-second request deadline.
Mount, session, admission and stream reconnect/replay changes restart the loop; cleanup aborts
outstanding reads and clears timers. A response is discarded after session/admission generation
or observed cursor changes. Accepted pending requests retain their separate exact-ID status
reconciliation and cannot be cleared by an activity read or cancel response. An idle boundary is
retained across later activity, so an old unowned repair cannot reappear when newer work ends.
Queue errors, malformed replies and network failures establish no new idle boundary; they retain
prior activity evidence. A never-observed request has no client-side activity evidence yet.

An active observation keeps queued work, preparation, verification and resume visible even before
any prompt. Until the first authoritative idle prefix, an ambiguous active legacy log retains its
latest unmatched turn and clock anchor conservatively. This does not assign that turn to a
request. Once idle is observed, only later event anchors can supply the elapsed clock. The UI
cannot know about an unseen future admission by another client: it learns through the next event
or activity read. This is an observation contract, not an admission lock. `/compact`'s leased-work
check is an advisory refusal; all accepted ordinary, manual and resume requests execute through
the queue's exclusive lease and renewal/grace fence. Ordinary prompts may queue behind active
work. The activity endpoint grants no execution permission.

Browser compatibility is negotiated on each socket with `repairOwnership=1`. The new client
sends it on initial connection and reconnect. Without it, the API removes only the optional
`repair` payload field from `user.message` at the common send gate, covering history replay,
buffered events, live delivery and cursor replay. Text, attachments, event identity, timestamps
and sequence numbers are unchanged. Old strict browsers therefore receive the prompt before
advancing past it. Durable events and internal readers always retain full metadata. The web has
no separate HTTP history delivery route. Publishing assets does not refresh old tabs, and no
refresh is required for this field under the legacy-safe delivery contract.

Old backend readers still reject new durable metadata. Deploy all API and reaper readers first,
then stop and drain every old worker before starting metadata-writing workers. Do not perform a
rolling old/new worker overlap. [DEPLOY.md](../DEPLOY.md#repair-ownership-rollout) gives the
operational sequence, barriers and rollback constraint. No database migration is needed. Local
fakes do not prove a mixed deployment or an actual worker crash; those remain operational checks.

This refines ADR-0009 and scaling-design sections 5 and 6. The no-requeue rule, human-triggered
continuation, protected context checkpoints and original append-only event log remain unchanged.
