# ADR-0027 — A steer joins the running turn at its next step, and the row decides where it lands

**Status:** Accepted, 2026-11-06. Built and tested on fakes, the in-memory sandbox and a real Postgres. No real model, no real E2B sandbox and no multi-pod deployment has run it, so whether models act on a steer well, and how quickly one is read across pods under load, are unmeasured. Closes the "steering a running turn" item ADR-0020 deferred.

## Context

A message sent while a turn ran used to become a turn request of its own. `TurnQueue` allows one in-flight request per session cluster-wide, so it waited until the running turn, its verification and its repairs had all finished. The composer did not even offer to send one, except behind a running compaction. The messages people send mid-turn are mostly corrections ("use Postgres, not SQLite"), and a correction that arrives after the turn has built the wrong thing costs that turn and the next one.

Devin's local harness injects a person's message into the running loop between iterations, and that was the feature reference. The design, wording and code here are Nap's own, and two facts about Nap shape them more than the reference does:

1. **The process that receives the message is not the one running the turn.** An API pod admits it; a worker pod, possibly another machine, runs the turn (`docs/DEPLOY.md`).
2. **The event log is the source of truth (ADR-0008), and a worker's death never re-runs anything (ADR-0009).**

## Decisions

### D1: Delivery is a durable row the worker reads at a step boundary

A **steer** is a row in `turn_steers`, joined to the leased turn request it was admitted to. The worker reads the request's waiting steers at each step boundary of the turn (D3), with one conditional update that marks them read and returns them: `pending → applied`, scoped to the request and conditional on this worker still holding the lease, exactly as a renewal is.

The alternatives, and why not:

- **A notification.** The cancel channel (ADR-0023) shows the pattern, but there is nothing to wake. A steer is only useful at a step boundary, and the worker reaches one between model calls, seconds apart. A wake-up could only make it read sooner by interrupting a model call, which we never do. So a notification would be one more listener for no change in when the agent reads anything. The steering query itself only runs while a turn runs, on a compute that is awake anyway (the Neon gotcha), and costs one indexed update per model call.
- **Riding the renewal.** Renewal is every fifteen seconds. A turn takes several steps in that time, and a steer read at renewal would miss most of them.

**Lease handover and a crash need nothing new.** The row belongs to the request, and the request to its lease. A worker that lost its lease reads nothing, because `take` is conditional on the owner. The janitor answers for the steers when it reclaims the request (D4).

### D2: Three events, and no event depends on another having landed

- `steer.received { steerId, text }` is written by the API, under the joined request's id, after the admission commits. Every tab can show the steer waiting.
- `steer.applied { steerId, text }` is written by the runtime under the turn reading it, at the point it was read, and **drained before the agent is handed the steer**. So the log says a steer was read before any model has read it (the guard test uses a store slower than the turn).
- `steer.dropped { steerId, text, reason }` is written by the runtime when a stopped request closes, and by the janitor for a reclaimed one. The reason names who ended it: `stopped` only for a person's Stop; `interrupted` for a dead worker, and for a worker that gave the turn up itself — a drain that ran out of time, or a lease that went away — because nobody pressed Stop and the pane says which happened.

A steer that became the next turn has no event of its own. That turn's `user.message` carries the steer's id as its turn id and is its record.

Each event carries the text, because two processes write them and their order is not guaranteed. The worker can record reading a steer before the API records receiving it. Every reader allows for that. The transcript decides where to draw a steer from all of its events, not from the first. The context engine replays only `steer.applied`. The janitor goes by the log, not by the row's state.

The row is the decision; the log is the record. Each transition is one conditional update, so a steer is read, deferred or dropped at most once.

### D3: It enters the loop at a step boundary, appended, and the context engine says how it reads

`TurnHook` gains a fifth seam, `interject()` (ADR-0020's hooks), with one user: the `Steering` hook. The loop asks it at two points, and never during a batch:

- **At the top of each step**, after the previous batch's results have been appended in their one message. The steer goes after those results, in the same user message. It never separates a result from its call, and it lands after every block the cache already holds, so no cached prefix is rewritten (ADR-0024).
- **When the model stops with no tool calls.** If a steer is waiting, the reply is kept and the steer becomes the next user message, and the turn goes on. Otherwise a correction sent during the last model call would wait for a whole new turn that starts by rebuilding the context this one holds.

Both points require room left to answer, not merely a step. At the top of a step: the step itself, and a next request that fits the turn's remaining tokens and the context's ceilings with a margin for the steer, whose size is unknown until it is taken — the same limits that step is about to fail on, so a step that is going to fail takes nothing. What it does not model is compaction, which that step may use to make room: where only compacting would fit the steer, the steer waits for a later step or for the next turn rather than being taken on the hope that compaction succeeds. At the stop point: two steps, as a stop hook's objection needs, one to read the steer and one for whatever it asks for, and the same fit, counting the model's final reply, which the next request carries ahead of the steer and the last one did not. Taking a steer marks it read for good, so one taken by a turn that then failed on its budget would be a message nobody answered, and would turn a turn that was finishing into a failed, uncommitted one. Left untaken, it becomes the next turn, with a budget of its own. A steer that, with any reminder a hook adds to the same request, is larger than the margin can still push that request over a ceiling; that turn then fails with the steer read. A turn that ended on a question or a proposal ends; its steers become the next turn, which is then the answer or the revision.

**The context engine owns the words.** `renderSteer` frames the text so it cannot be read as more of the last tool's output. It reaches the loop through `BuiltContext.renderSteer`, and the engine uses the same function to replay `steer.applied` from the log. So a compaction mid-turn, and every later turn, re-reads the steer as the model first read it. A steer survives eviction and compaction like an original request: the person said it, and it outlives the work it changed. A context that cannot say how a steer reads is offered no steers.

### D4: The races at the edges, and where each message lands

**Admission and the end of a request are serialized on the request's row.** `steer()` joins a request only if it is leased, of kind `turn`, not a `/compact`, not cancelling, not yet closed to steers, in the same plan mode, and has fewer than `MAX_WAITING_STEERS` waiting. It checks all of that while holding the request's row `for no key update`. At the end of the request, after its last turn and before it is settled, the worker calls `close()`. That sets `steering_closed` on the same row, which conflicts with the admission lock, and resolves the waiting steers in the same transaction. A steer therefore joined before the close (and the close resolves it) or arrived after (and was queued as a turn). The `db` suite stages the losing interleaving deterministically, and it fails without the lock and without the flag. A second staged test holds the row while two messages race for the backlog's last place, and fails if the lock is weakened to one two admissions can share.

**A Stop on the row wins over the worker.** A cancel is in the request's row as soon as it is asked for, and reaches the worker a wake-up or a renewal later. In between, `take` hands the turn nothing, and `close` reads the flag from the row it locks and drops the waiting steers whatever the worker asked for. Deferring them would queue them as turns the Stop never saw, and those would run.

| A message sent… | Lands |
|---|---|
| while a turn runs and has a step left | read at the next step boundary (`steer.applied`) |
| during the turn's last model call | read when the model stops; the turn goes on |
| after the person's turn, while checks or a repair run | read by a repair turn if there is one; otherwise the next turn |
| after the request closed, or with nothing running | the next turn, under its own id |
| when the turn ended on a question or a proposal | the next turn: the answer, or a revision of the plan |
| to a turn being stopped | the next turn: a message sent after Stop is a new message |
| then the turn is stopped before reading it | dropped (`stopped`), offered back, nothing runs |
| then the worker dies or loses its lease | dropped (`interrupted`) by the janitor, offered back, nothing runs |
| then the worker shuts down before the turn ends | dropped (`interrupted`) by the runtime, offered back, nothing runs |
| with images, a `/compact`, or a plan approval | the next turn; each is a turn of its own |
| to a compaction, an app test, a resume or a publish | the next turn; none takes steers |
| as a fourth while three wait | the next turn |

**Deferring is not autonomous spend; re-running is.** A request that ends normally queues its unread steers as turns, because somebody sent them moments ago and is waiting for an answer. Each is admitted and charged already (D5), and queued in the order it was sent. A request that was stopped, or whose worker died, runs nothing more on its own (`CONTEXT.md`, *Continue*), and its unread steers are offered back.

**Plan mode.** A steer joins only a request in its own mode. A planning message joins a planning turn and shapes the plan before it is proposed. After the proposal it is the next message, and ADR-0025's fold already says what that does: another planning message revises the plan. A steer cannot approve a plan, since an approval names a waiting plan and nothing waits while a turn runs. **Helpers** do not take steers. The parent reads them at its own step boundaries, so a foreground helper delays them until it returns.

**Idempotency.** The client chooses the id. It is the steer's id, and the id of the turn request the steer becomes if it falls back. A retried POST is answered from what the first attempt did, before anything is charged. Two retries racing down the same path collide on a primary key, and the loser is answered the same way. Two racing down different paths would not — one joining, the other finding the backlog full, the request just closed, or nothing running yet and falling back to a turn, in a table where nothing collides with the steer. The request's row does not serialize those, because the two need not want the same row: one can find nothing running and queue a turn, a worker then claim a request, and the other find that request to join. So admission begins by taking a transaction-scoped lock on the id itself, and looks for the id again once it holds that lock and the request's row, answering from what the attempt ahead of it did. Every attempt at one id therefore runs after the one before it has committed. `close` also tolerates a turn request already under a steer's id: that is the message already queued, so the steer is recorded deferred and nothing is inserted twice. An id already used by another session or person is refused.

**What is not closed:**

- A commit whose acknowledgement is lost, or a database lost between marking a steer read and recording it. Either leaves a steer read in the row with no event, on a healthy worker that settles normally. Nothing re-runs it, and the pane offers it back once the session is seen idle past it (D6). Same class of gap as a lost settle acknowledgement.
- Exits that never reach the runtime's close: a request whose person's key is gone by the time it is claimed, a session that vanished, a runtime that threw, or a `close` that failed (it is logged, not retried). Each settles the request with its steers still pending, and no event or process answers for them. The pane's `undelivered` status is the net (D6), and it needs the API's `steer.received` to have landed.
- A Stop that arrives between a `take` committing and the model call. The steer is recorded read in a turn that then stops, and is not offered back.

### D5: Admitted as a prompt, charged as a prompt, bounded per turn

`POST /sessions/:id/steers` runs the turn route's checks in the turn route's order: ownership (another person's session is a 404), `resolveTurnAccess`, the sandbox quota, then the rate limit, which records. **Every steer is charged whichever way it lands.** Charging only the ones that become turns would let anybody convert steers into free turns by sending them just as a turn ends, which is when unread ones are queued.

A steer that joins adds no steps and no tokens to the turn's budget. It is read inside the turn's existing ceilings and re-sent on each of the turn's remaining model calls, so it is a real cost inside that budget. Bounding the flood: at most `MAX_WAITING_STEERS` (three) wait on one request, and the next is queued as a turn, which the rate limit bounds as it bounds any prompt. A steer runs on the running turn's model. The model the route resolved for it is used only if it falls back.

### D6: The pane draws a steer where it landed, from the log

The transcript fold gains one item kind, `steer`, with five statuses:

- `read` is drawn where `steer.applied` sits. It stays in view when its turn folds, between the work it split, because the fold hides only the agent's work.
- `dropped` is drawn where `steer.dropped` sits, with **Send again**. That carries the plan intent of the turn it was sent to, read off that turn's prompt, so a planning message sent again still plans.
- `waiting` (the request it joined is still running, including a repair of it) and `queued` (that request has ended, so it is a turn of its own behind whatever runs now) are drawn after everything else, and after the live row, which the timeline keeps intact by setting them aside first.
- `undelivered` is a steer the server has said the session is idle past, using the activity observation ADR-0017 introduced. It is offered back. This is the net for the paths that write nothing after `steer.received`: a steer that joined, was deferred and whose turn was then cancelled while queued; a request that ended without closing; and D4's lost acknowledgement. It is drawn only from `steer.received`, so it does not catch a message that fell back to a turn at admission and was then cancelled while queued — that one has no steer event, and goes the way of any queued prompt a Stop fails — nor an admitted steer whose `steer.received` never landed.

A steer that became a turn is drawn as that turn's prompt and nothing else. Every status is a fold over events, so a reload and a second tab draw the same thing.

The composer accepts a message while a turn runs ("Send to the running turn", beside Stop), words only, and one at a time: while a submission is still on its way it takes nothing more, since a second would take the first one's place on screen and leave a failure of the first nowhere to be shown. A message that fell back to a turn is such a submission until that turn starts — it is drawn as the queued message, not as a steer — so after one, the composer stays disabled for the rest of the running turn, as it did before steering existed. Before the log has the steer, it is drawn optimistically in the same place and shape as a waiting one. The log's copy replaces it after everything else, as the waiting one is drawn; the two sit in different wrappers, so it can shift by a line.

### D7: It is exercisable for free

`bun run harness --steer="…" "<prompt>"` runs the turn under a lease on an in-memory queue. The message is admitted while the first model call is in flight, and the stream shows `steer.received`, then `steer.applied` after that call's tool result, before the next model call. `--plan --steer=…` does the same for a planning turn.

## Consequences

- Three event types, one table (`turn_steers`, migration 0019), one column (`turn_requests.steering_closed`), one port (`SteerQueue`, implemented by both queues), one hook seam, one route. Every exhaustive consumer handles the events: the turn log (shape only, never the words), the harness printer, the transcript and its treatment tables, and the db round-trip fixtures.
- **The composition takes `queue: TurnQueue & SteerQueue`**, one dependency rather than two, because the fence needs one store.
- **Rollout order matters, as in ADR-0025.** Old readers parse events strictly, so an old tab, API or worker rejects `steer.*`. An old worker would also run a request without reading its steers or closing it. That request settles normally, so the janitor never looks at it, and every steer joined to it waits until the pane offers it back as undelivered. Migrate first, then drain and replace the workers, then the API and reaper, then the web. Only the new API admits a steer, and only the new web sends one. `docs/DEPLOY.md` has the steps.
- **Known limitations:**
  - `renderSteer`'s framing is a fixed, public string. Tool output — a file in an imported repository, a command's output — can carry the same framing inside a tool result, and the system prompt does not say that a real steer only ever arrives as the person's own text. Its "where it conflicts … it wins" wording is also replayed in every later turn, beside later prompts that may say otherwise. Neither has been measured; both need a real-model check before being changed.
  - The composer says "steer" while any turn runs, including runs that take no steers (an app test, a publish, a turn in the other plan mode). The server queues those messages as turns, which is correct; only the wording is wrong.
  - A steer that joins is charged to the sender's limiter as it stands when they send it, but runs on the running turn's model and is paid by that turn's payer. These differ only if the person adds or removes a key mid-turn, and the extra spend is bounded by the turn's own budget and the backlog cap.
- **Unmeasured:** whether a real model weighs a steer as intended under `renderSteer`'s framing; how a steer read mid-turn affects cache reads on a real provider (the bytes are appended after the cached prefix, but this has not been observed in billing); and pickup latency across pods, which is bounded below by the model call in flight and has no number yet.
