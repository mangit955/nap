# ADR-0010 — Event fanout is notify-then-read, and the log is the delivery

**Status:** Accepted — 2026-08-23

## Context

An event reaches a browser in two hops: `EventSink` appends it to the durable log, and then
publishes it to the `EventBus`, which hands it to whichever sockets are watching that session.
Append-before-publish has been the rule since v1 and is invariant 2 — no client is ever sent an
event that is not in the log.

`InProcessEventBus` implemented the second hop as an emitter keyed by session id. That is exactly
right for one process and silently wrong for two: after ADR-0009 the turn runs on a *worker* and
every socket watching it is on an *API pod*, so with an in-process bus every turn would execute
perfectly while every chat pane sat still. Nothing would error. The fanout had to cross processes.

The obvious designs all move the event itself. Redis pub/sub with the event as the message; a
NOTIFY carrying the payload; routing each session's socket to the pod that owns its turn so the
in-process bus keeps working.

## Decision

**`PostgresNotifyEventBus`: `pg_notify` carries `{sessionId, seq}` and never a payload, the
receiving pod reads the events out of the durable log, and a catch-up poll runs the same read
unconditionally every two seconds.**

`packages/db/src/postgres-notify-event-bus.ts`, behind `NAP_EVENT_BUS=postgres`. Nothing above the
`EventBus` port changed: `EventSink` still appends then publishes, `openEventStream` still
subscribes, replays and gates on `lastSentSeq`.

### Why the payload never travels

**Because the largest events are exactly the ones it would fail on.** Postgres caps a NOTIFY
payload at 8000 bytes. Nap events carry command output and file contents, so a payload-carrying
design works in development and in every test and then drops precisely the `command.output` and
`file.written` events that matter most — a failure mode that is invisible until it is a user's
build log going missing. Redis has no such cap and would still be the wrong shape, because a
message and a row are then two copies of one event that can disagree, and the socket's replay path
(`?afterSeq=`) reads the row while the live path reads the message. One of those two would be the
tested one.

Reading from the log makes the live path and the replay path the same path. It also makes duplicate
wake-ups harmless: each session has one cursor, it only moves forwards, and every read starts above
it (invariant 3).

### Why the poll is a durability backstop, not an optimisation

**Invariant 21: suppressing `pg_notify` entirely must still deliver every event.** That is the test
that keeps the slogan honest — *a notification is a wake-up signal, the durable log is the
delivery* — and the poll is what makes it literally true rather than aspirational. Without it the
sentence is a description of the happy path and the system quietly depends on a datagram that
Postgres does not promise to deliver across a dropped connection, a failover, or a process that
died between commit and notify.

Calling it an optimisation would invert its purpose and invite somebody to tune it away under load.
It is the mechanism of last resort; the notification is the thing that makes it fast. The cost is
bounded by shape rather than by tuning: the poll is **one query for every session a process is
streaming**, not one per session, which is what `EventTailReader` exists for. A hundred sessions
polled independently would be fifty queries a second of pure overhead against the database that is
also running the turns.

### Why the notify sits in the bus rather than inside the append transaction

The first design put the NOTIFY inside `append()`'s transaction, to close the window where a
process commits an event and dies before announcing it. **Keeping the poll reverses that**, because
the poll closes the same window, and paying for it twice costs the architecture something real.

|  | Inside `append()` | `PostgresNotifyEventBus.publish()` |
|---|---|---|
| Append before publish | Structural | **Preserved** — `publish()` is only reachable after `append()` returns, and `append()` returns only on commit |
| Nothing announced for a rolled-back append | Yes | **Yes** — a rollback throws out of `append()`, `EventSink` records the failure and stops the chain, so `publish()` is never called |
| Responsibilities kept apart | **No** — the store takes on fanout signalling, and `EventBus.publish` becomes a no-op that reads as dead code | **Yes** — one new class behind an existing port |
| Size of the change | Changes the store, the port's meaning, and the ordering rule documented in `event-sink.ts` | One swapped implementation at boot |

The explicit trade-off: a worker that dies between the commit and the `pg_notify` leaves an event
durable but unannounced for up to one poll interval. **The event is never lost** — it arrives within
2s, or immediately on the next event for that session. Two seconds of added latency on a rare crash
path, in exchange for leaving the store, the sink and the port exactly as they were.

### Why not route sockets to the owning pod

Sticky routing keeps the in-process bus and buys a great deal of trouble: a client reconnecting
mid-turn must land on the same pod, a rolling restart moves every session, and a session with no
turn running has no owner to be sticky to. It also makes the ingress responsible for a correctness
property. The log-as-delivery design is indifferent to which pod a socket is on, which is what
lets `infra/k8s/proof` submit a turn to one API pod and stream it from another.

## Consequences

**`LISTEN` needs a session-mode connection, and that leaks into deployment.** *(This one is
operational as well as architectural, so the version somebody debugging at 2am needs is in
`docs/GOTCHAS.md` under API, auth and logging; what follows is why the design accepted it.)* It cannot go through
a transaction pooler — the `LISTEN` lands on a backend that is returned to the pool and the process
then hears nothing while every query it runs keeps working. Hence `NAP_LISTEN_DATABASE_URL`
pointing at a direct endpoint, and hence `/readyz` growing a `listener` check that fails: a pod
whose fanout has degraded to the 2s poll should leave the rotation while a healthy pod's has not.
`/livez` deliberately does not fail on it — the connection reconnects on its own, and restarting
would only drop the sockets the pod still had.

**Liveness of the listener is a heartbeat, not an assumption.** The process hears its own
notifications, which is deliberate rather than tolerated: the local and remote paths are then the
same path, so there is no second delivery route that only one replica ever exercises — and the echo
is what tells the pod its `LISTEN` is still alive. Three missed intervals, not one, before it calls
itself down.

**It got faster, which was not the expectation.** A function call was replaced by `pg_notify` plus a
read across a process boundary, and at 100 concurrent turns append-to-delivery p95 went from 40ms
in-process to **17ms** on the cluster (`docs/scaling-cluster.md`). The reason is not that Postgres
beats a function call: the single process was doing the fanout *and* running every turn on one
event loop.

**`NAP_EVENT_BUS` still defaults to `in-process`**, so the Railway deployment keeps the v1 behaviour
until it is switched. The worker and the reaper refuse to boot without `postgres`, because for them
the wrong setting is not a degradation — it is turns running perfectly while nobody can see them.
