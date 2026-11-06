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
- `steer.dropped { steerId, text, reason }` is written by the runtime when a stopped request closes (`stopped`), and by the janitor for a reclaimed one (`interrupted`).

A steer that became the next turn has no event of its own. That turn's `user.message` carries the steer's id as its turn id and is its record.

Each event carries the text, because two processes write them and their order is not guaranteed. The worker can record reading a steer before the API records receiving it. Every reader allows for that. The transcript decides where to draw a steer from all of its events, not from the first. The context engine replays only `steer.applied`. The janitor goes by the log, not by the row's state.

The row is the decision; the log is the record. Each transition is one conditional update, so a steer is read, deferred or dropped at most once.

### D3: It enters the loop at a step boundary, appended, and the context engine says how it reads

`TurnHook` gains a fifth seam, `interject()` (ADR-0020's hooks), with one user: the `Steering` hook. The loop asks it at two points, and never during a batch:

- **At the top of each step**, after the previous batch's results have been appended in their one message. The steer goes after those results, in the same user message. It never separates a result from its call, and it lands after every block the cache already holds, so no cached prefix is rewritten (ADR-0024).
- **When the model stops with no tool calls.** If a steer is waiting, the reply is kept and the steer becomes the next user message, and the turn goes on. Otherwise a correction sent during the last model call would wait for a whole new turn that starts by rebuilding the context this one holds.

Both points require a step left to answer. Taking a steer marks it read for good, so one taken by a turn that then cannot call the model would be a message nobody answered. Left untaken, it becomes the next turn. A turn that ended on a question or a proposal ends; its steers become the next turn, which is then the answer or the revision.

**The context engine owns the words.** `renderSteer` frames the text so it cannot be read as more of the last tool's output. It reaches the loop through `BuiltContext.renderSteer`, and the engine uses the same function to replay `steer.applied` from the log. So a compaction mid-turn, and every later turn, re-reads the steer as the model first read it. A steer survives eviction and compaction like an original request: the person said it, and it outlives the work it changed. A context that cannot say how a steer reads is offered no steers.

### D4: The races at the edges, and where each message lands

**Admission and the end of a request are serialized on the request's row.** `steer()` joins a request only if it is leased, of kind `turn`, not a `/compact`, not cancelling, not yet closed to steers, in the same plan mode, and has fewer than `MAX_WAITING_STEERS` waiting. It checks all of that while holding the request's row `for no key update`. At the end of the request, after its last turn and before it is settled, the worker calls `close()`. That sets `steering_closed` on the same row, which conflicts with the admission lock, and resolves the waiting steers in the same transaction. A steer therefore joined before the close (and the close resolves it) or arrived after (and was queued as a turn). The `db` suite stages the losing interleaving deterministically, and it fails without the lock and without the flag.

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
| with images, a `/compact`, or a plan approval | the next turn; each is a turn of its own |
| to a compaction, an app test, a resume or a publish | the next turn; none takes steers |
| as a fourth while three wait | the next turn |

**Deferring is not autonomous spend; re-running is.** A request that ends normally queues its unread steers as turns, because somebody sent them moments ago and is waiting for an answer. Each is admitted and charged already (D5), and queued in the order it was sent. A request that was stopped, or whose worker died, runs nothing more on its own (`CONTEXT.md`, *Continue*), and its unread steers are offered back.

**Plan mode.** A steer joins only a request in its own mode. A planning message joins a planning turn and shapes the plan before it is proposed. After the proposal it is the next message, and ADR-0025's fold already says what that does: another planning message revises the plan. A steer cannot approve a plan, since an approval names a waiting plan and nothing waits while a turn runs. **Helpers** do not take steers. The parent reads them at its own step boundaries, so a foreground helper delays them until it returns.

**Idempotency.** The client chooses the id. It is the steer's id, and the id of the turn request the steer becomes if it falls back. A retried POST is answered from what the first attempt did, before anything is charged. Two retries racing collide on a primary key, and the loser is answered the same way. An id already used by another session or person is refused.

**What is not closed:** a commit whose acknowledgement is lost, or a database lost between marking a steer read and recording it. Either leaves a steer read in the row with no event, on a healthy worker that settles normally. Nothing re-runs it, and the pane offers it back once the session is seen idle past it (D6). Same class of gap as a lost settle acknowledgement.

### D5: Admitted as a prompt, charged as a prompt, bounded per turn

`POST /sessions/:id/steers` runs the turn route's checks in the turn route's order: ownership (another person's session is a 404), `resolveTurnAccess`, the sandbox quota, then the rate limit, which records. **Every steer is charged whichever way it lands.** Charging only the ones that become turns would let anybody convert steers into free turns by sending them just as a turn ends, which is when unread ones are queued.

A steer that joins adds no steps and no tokens to the turn's budget. It is read inside the turn's existing ceilings and re-sent on each of the turn's remaining model calls, so it is a real cost inside that budget. Bounding the flood: at most `MAX_WAITING_STEERS` (three) wait on one request, and the next is queued as a turn, which the rate limit bounds as it bounds any prompt. A steer runs on the running turn's model. The model the route resolved for it is used only if it falls back.

### D6: The pane draws a steer where it landed, from the log

The transcript fold gains one item kind, `steer`, with five statuses:

- `read` is drawn where `steer.applied` sits. It stays in view when its turn folds, between the work it split, because the fold hides only the agent's work.
- `dropped` is drawn where `steer.dropped` sits, with **Send again**. That carries the plan intent of the turn it was sent to, read off that turn's prompt, so a planning message sent again still plans.
- `waiting` (a turn is running) and `queued` (none is) are drawn after everything else, and after the live row, which the timeline keeps intact by setting them aside first.
- `undelivered` is a steer the server has said the session is idle past, using the activity observation ADR-0017 introduced. It is offered back. This is the net for every path that writes nothing: a deferred turn cancelled while queued, or D4's unclosed window.

A steer that became a turn is drawn as that turn's prompt and nothing else. Every status is a fold over events, so a reload and a second tab draw the same thing.

The composer accepts a message while a turn runs ("Send to the running turn", beside Stop), words only. Before the log has the steer, it is drawn optimistically in the same place and shape as a waiting one. The log's copy replaces it without anything moving.

### D7: It is exercisable for free

`bun run harness --steer="…" "<prompt>"` runs the turn under a lease on an in-memory queue. The message is admitted while the first model call is in flight, and the stream shows `steer.received`, then `steer.applied` after that call's tool result, before the next model call. `--plan --steer=…` does the same for a planning turn.

## Consequences

- Three event types, one table (`turn_steers`, migration 0019), one column (`turn_requests.steering_closed`), one port (`SteerQueue`, implemented by both queues), one hook seam, one route. Every exhaustive consumer handles the events: the turn log (shape only, never the words), the harness printer, the transcript and its treatment tables, and the db round-trip fixtures.
- **The composition takes `queue: TurnQueue & SteerQueue`**, one dependency rather than two, because the fence needs one store.
- **Rollout order matters, as in ADR-0025.** Old readers parse events strictly, so an old tab, API or worker rejects `steer.*`. An old worker would also run a request without reading its steers or closing it. That request settles normally, so the janitor never looks at it, and every steer joined to it waits until the pane offers it back as undelivered. Migrate first, then drain and replace the workers, then the API and reaper, then the web. Only the new API admits a steer, and only the new web sends one. `docs/DEPLOY.md` has the steps.
- **Unmeasured:** whether a real model weighs a steer as intended under `renderSteer`'s framing; how a steer read mid-turn affects cache reads on a real provider (the bytes are appended after the cached prefix, but this has not been observed in billing); and pickup latency across pods, which is bounded below by the model call in flight and has no number yet.
