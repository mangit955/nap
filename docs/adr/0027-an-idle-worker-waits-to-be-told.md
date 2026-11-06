# ADR-0027: An idle worker waits to be told, and polls slowly in case it is not

**Status:** Accepted, 2026-11-06. Amends `docs/scaling-design.md` §5, which says nothing about how often a worker claims. ADR-0023 is the model this follows.

## Context

An idle worker ran `claim` every 100 ms for as long as it lived. That is ten transactions a second per worker. Each one is a `select … for update skip locked` that finds nothing. Always-on database load like this is what used up the Neon free compute in September 2026. The 100 ms poll was also the floor on how quickly an accepted turn could start.

## Decisions

### D1: A wake-up is a reason to ask, and the claim decides

`ClaimChannel` has the same shape as `CancelChannel`: `announce()` and `listen(handler)`, over `LISTEN`/`NOTIFY` on the transport the event bus already uses. The payload is empty. When a worker hears one, it runs the claim it would have run on its timer. The claim is still the only thing that takes a row, so a lost, duplicated, late or stray wake-up costs one claim query or some latency, and nothing more. Every idle worker hears every wake-up. One of them gets the row and the others find nothing, so N workers run N claims per enqueue, where before they ran 10·N a second.

### D2: Whatever writes the row announces, after it commits

A request becomes claimable in four ways:

| Event | Announced by |
|---|---|
| A request is enqueued | `PostgresTurnQueue.enqueue`, `PostgresSessionStartStore.start` (a new project's first turn) and `PostgresGitHubStore.importRepository` and `approveFeedback`, each after its own transaction |
| A lease is settled, freeing its session for the request queued behind it | `PostgresTurnQueue.settle`, when it settled something |
| The janitor reclaims an expired lease | `PostgresTurnQueue.orphanExpired`, when it reclaimed something |
| One of a worker's own turns finishes, freeing a slot | Nobody. The worker asks again by itself |

A cancel makes nothing claimable. A queued request is failed outright, and a leased one gives its session back when the worker settles it, and that settle announces.

ADR-0023 D3 kept the cancel announcement in the route, so that `TurnQueue` would not have to know about a transport. That reasoning does not carry over here. A cancel has one writer. A claimable request has five, three of them insert into `turn_requests` inside transactions of their own (to create a project and its first request together), and one is the very first prompt of every new project. Announcing from the route would have meant remembering it at every call site, and grepping for `queue.enqueue` would already have missed the three stores. So each writer takes a `ClaimAnnouncer`, which is a port and not a transport. The argument is required and nullable, the same pattern `NapDeps.cancels` uses: a new construction site does not compile until it decides. `test/claim-writers.test.ts` fails on any shipped file that inserts into `turn_requests` and never calls `.announce()`. `packages/db/src/claim-announcements.db.test.ts` checks that every existing writer announces, and that it does so after its commit.

We considered `pg_notify` from a trigger on `turn_requests` and rejected it. A trigger would catch every writer by construction. It would also tie the write to the wake-up: when Postgres's notification queue is full, a transaction that called `NOTIFY` fails at commit, so enqueue and settle would fail on a problem that ought to cost only latency. Announcing after the commit keeps a failed notification a missed wake-up, which the fallback poll covers.

### D3: The fallback poll stays, at five seconds

A wake-up can be lost. The socket may be down when it is sent, or a request may become claimable in a way nothing announces: the owner's computer-control operation on the project ends, a claim gives up after losing four races, or a project row is briefly locked. So a worker that can hear still claims once per `NAP_WORKER_FALLBACK_POLL_SECONDS`, default 5 and at most 30. A lost wake-up delays a turn by that long and never leaves it stuck.

Five seconds is fifty times fewer claim transactions than the 100 ms loop, and short compared with how long a turn runs once it starts. It is also the heartbeat writer's own throttle, so an idle worker's liveness file is written about as often as before. The cap of 30 is there because the claim loop coming round is the worker's liveness signal. The probe restarts a pod that has been silent for 120 seconds.

### D4: A worker that cannot hear drops back to 100 ms

A worker polls at the old fast interval while its claim `LISTEN` has not answered, after it has failed, and whenever `hearing()` says no. `hearing()` is the event bus's echo heartbeat, which travels over the same socket, so it costs no extra traffic. Losing the listener takes a worker back to the old behaviour and never makes it worse. Unlike the cancel `LISTEN`, the first claim does not wait for this one.

### D5: Anything that happens during a claim sends the loop straight round

A wake-up, or a turn of the worker's own finishing, sets a flag as well as cutting the current wait short. The loop clears the flag before each claim, so if a request commits after the claim read an empty queue, the next round begins at once and the request does not wait for the fallback. `stop()` cuts the wait short too, so a shutdown is not held up for five seconds.

## Consequences

- **Idle claim load per worker falls from about 10 queries a second to about 0.2.** That is the claim loop alone. The event bus's 2 s echo, one `pg_notify` per process every two seconds, is unchanged and is now the larger share. A worker's bus has no subscribers, so its catch-up tick reads nothing. The `LISTEN` connection still keeps a Neon compute from scaling to zero, so this reduces the load on that compute but does not stop it running.
- **An accepted turn starts on the wake-up's round trip**, a few milliseconds on a local socket, instead of after up to 100 ms. `apps/api/src/split.db.test.ts` checks this across two compositions with the worker's fallback set to 30 s.
- **The load tooling still runs at the old cadence.** `apps/api/scripts/loadgen-composition.ts` composes with `claims: null`, so its worker polls at 100 ms as every recorded baseline did. `apps/api/scripts/cluster-proof.ts` is wired as `bootNap` is. The k8s ramp in `docs/scaling-cluster.md` was measured with the old loop, and its admission-to-start figures should be re-run before they are quoted against this one.
- **`boot.ts` wiring is guarded by the type system, not by a test.** A writer built there with `claims: null` would compile. That would have to be a deliberate choice rather than something forgotten, and it would show up as a worker that hears nothing.
