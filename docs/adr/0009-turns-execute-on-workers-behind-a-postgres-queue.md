# ADR-0009 — Turns execute on workers behind a Postgres queue

**Status:** Accepted — 2026-08-23

## Context

Until V2, **the API process was the worker.** `POST /sessions/:id/turns` answered `202` and then
detached `runtime.runTurn`, which ran for tens of seconds to minutes inside the process that served
the request; `POST /projects/:id/open` did the same with `resumeSession`. Two turns for one session
were kept apart by `SessionQueue` — a `Map` of promises, correct in one process and enforcing
nothing across two. (It is still there, and deliberately: it is now a second, in-process line
rather than the only rope.)

That shape has a hard ceiling and one specific failure. The ceiling is that a request's lifetime is
the turn's lifetime, so a deploy, a crash or a scale-down is a lost turn, and there is nothing to
scale independently: sockets and model loops share an event loop. The failure is worse — with two
API replicas, two processes accept two turns for one session, each calls `acquireSandbox`, and the
project ends up holding two E2B sandboxes, one of which nothing references and nothing stops paying
for.

So execution has to leave the request, which means a durable queue and a pool of things that read
it. The question was which queue.

**Redis (BullMQ), NATS JetStream and a hosted queue (SQS, Cloud Tasks) were the real alternatives.**
All three are better queues than a table. Each brings retry policy, backoff, dead-letter handling,
delayed delivery and a visibility timeout that we would otherwise write ourselves — and every one of
those features is aimed at redelivery, which is the thing this system must not do.

## Decision

**A `turn_requests` table in Postgres, claimed with `for update skip locked`, with per-session
exclusivity enforced by a partial unique index and no path back to `queued`.**

```sql
create unique index turn_requests_one_leased_per_session
  on turn_requests (session_id) where state = 'leased';
```

`packages/db/src/postgres-turn-queue.ts` is the implementation; `docs/scaling-design.md` §5 and §6
are the semantics. `apps/api/src/worker.ts` is the process that drains it.

Four reasons, in the order they actually decided it.

**The event log, not the queue, is what makes recovery correct.** A Job is a fold over the durable
event log — `foldJobs` in `@nap/shared`, with no jobs table behind it — so whether a turn ran, how
far it got, how many repairs it has spent and whether its commit was checkpointed are all answers
Postgres already holds. Redelivery is therefore not a feature we want: re-running a turn a worker
half-executed would spend tokens and money on work the log already records, and the correct
response to a worker dying is to write the terminal event the interrupted Turn never got and wait
for a human to reopen the project (`CONTEXT.md`, **Janitor**; invariant 7 — *no autonomous token
spend, ever*). **A broker's redelivery semantics — the reason you would pay for a broker — buy
nothing here, and the ones that retry by default are actively wrong.** What the queue must supply
is exclusivity and a claim that is taken exactly once, which is a unique index and `skip locked`.

**Two stores would be two answers to one question.** Admission writes a rate-allowance row and a
turn request; a worker settles a request and appends events; "is this session busy?" is asked by
project close, project delete and the idle sweep. With the queue in Redis, a turn is in flight
according to Redis and absent according to Postgres for as long as the two disagree, and every
reconciliation path becomes a two-system problem. In one database it is one transaction and one
`state = 'leased'` query (`TurnQueue.anyLeased`), and the invariant that matters — one in-flight
request per session cluster-wide — is adjudicated by the storage engine rather than by application
logic in whichever process asked first.

**The throughput this needs is not the throughput a broker is for.** A turn is 8–43 seconds against
a real model and minutes with verification and repairs, so 100 concurrent turns is single-digit
claims per second. The cluster run (`docs/scaling-cluster.md`) held 100 leased turns with queue
depth never exceeding 2, on an in-cluster Postgres also serving every event append. Choosing a
broker here would be provisioning for a load profile this system does not have, and paying for it
in operations.

**A table is legible and already integrated.** The queue is readable from `psql`, KEDA's built-in
`postgresql` scaler reads its depth directly — which is how workers autoscale, with no exporter in
between — and the janitor that closes out an abandoned request is a query rather than a
dead-letter consumer.

## Consequences

**At-least-once delivery, at-most-once logical execution.** These are different guarantees and the
distinction is load-bearing (invariant 12). The claim may be attempted more than once; a request is
*claimed* at most once, because there is no `attempts` column and no transition back to `queued`.
Losing a lease never requeues.

**A worker that dies mid-turn costs a human a reopen, and that is the accepted price.** Nothing
resumes the work autonomously. The janitor marks the request `orphaned` past the lease's grace
window and writes the terminal event, so no chat pane spins forever; continuing the Job waits for
somebody to open the project.

**Fencing is the caller's job, and it is everywhere.** Lease renewal is conditional on the request
id, the owner and the state; zero rows back means the lease is gone and the turn must abort at
once. A broker's visibility timeout would have made that the broker's problem; here every statement
in `postgres-turn-queue.ts` carries the `lease_owner` predicate, and the reason is written above
them.

**The claim is two statements in one transaction rather than the single statement the design
wrote.** Selecting the candidate first — still `for update skip locked` — is what lets a `23505`
from the unique index be retried against the *next* candidate; the one-statement form aborts
without ever saying which row it was about to take. The index is still the mechanism, not a
backstop.

**Postgres is now a harder dependency than it was, and the pool sizing is a real constraint.** Every
process holds connections for the queue, the event log, the LISTEN socket (ADR-0010) and the
reaper's advisory lock; the cluster run peaked at 51 connections across nine pods. A pool that is
too small looks like latency, not like an error.

**The queue is not the ceiling on spend, and must not be mistaken for one.** `NAP_MAX_SANDBOXES_TOTAL`
is, through `sandbox_reservations`; the worker's `maxReplicaCount` is derived from it precisely so
that no scaling decision on queue depth can outrun it.
