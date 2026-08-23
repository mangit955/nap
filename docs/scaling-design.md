# Scaling Nap to 100 concurrent turns

**Status: design resolved, reviewed, and settled. Nothing is built.** No Kubernetes manifests, no
migrations, no runtime changes. §19 is the migration sequence that turns this into code, and step 0
of it has not started.

The goal is not "run Nap on Kubernetes". It is: horizontally scale Nap while preserving durable
event ordering, Job correctness, checkpoint semantics, sandbox isolation, cancellation and bounded
spend — and then prove it with a reproducible 100-concurrent k6 run.

---

## 1. Current architecture, as the code actually is

### The two long-running entry points

Both answer immediately and run for minutes afterwards **inside the API process**:

| Route | What it detaches | Where |
|---|---|---|
| `POST /sessions/:id/turns` | `runtime.runTurn` — model loop, sandbox exec, verify, ≤3 repairs, snapshot, screenshot | `apps/api/src/turns/routes.ts:167` |
| `POST /projects/:id/open` | `runtime.resumeSession` — restore, and continue whatever job the log left open | `apps/api/src/projects/routes.ts:208` |

There is no queue. **The API process *is* the worker.** That is the single fact the whole design
turns on.

### What is already cluster-safe

This is more than the brief assumed, and it is why the change is smaller than it looks.

- **`seq` allocation.** `PostgresEventStore.append` (`packages/db/src/postgres-event-store.ts:58`)
  takes `pg_advisory_xact_lock(hashtext(session_id))` and derives `seq` inside the insert
  statement. Its own doc comment already reasons about "several API processes".
  `unique(session_id, seq)` is the database-level backstop.
- **Job state is derived, not stored.** There is no jobs table. `foldJobs` reads the event log and
  `continuationFor` (`packages/runtime/src/continue-job.ts`) decides what an interrupted job needs.
  **A half-executed turn is already recoverable from Postgres alone** — the single most valuable
  property for a distributed design, and it exists today.
- **Replay and dedupe.** `openEventStream` (`apps/api/src/ws/event-stream.ts`) subscribes, buffers,
  reads history, flushes, then tails; every outbound event passes one `lastSentSeq` gate. A client
  reconnecting with `?seq=N` gets exactly the gap.
- **Sandbox ownership** is a Postgres column, `projects.sandbox_id`. (There is no
  `sessions.sandbox_id`: `PostgresSessionStore.setSandboxId` writes the *project's* column,
  reached through the session's `project_id`. Corrected when §7 was built.)
- **The global sandbox count** already reads from Postgres, so it is cluster-wide — though not
  atomic. See §7.

### The single-process assumptions, exhaustively

| Thing | File | What breaks at N>1 |
|---|---|---|
| `InProcessEventBus` | `packages/db/src/in-process-event-bus.ts` | A socket on pod A never sees a turn on pod B. The chat stops moving. |
| `SessionQueue` | `packages/runtime/src/session-queue.ts` | **The expensive one.** Two pods run two turns for one session; each calls `acquireSandbox`; the project ends up with two sandboxes, one of which nobody can find and nobody stops paying for. |
| `TurnRegistry` | `apps/api/src/turns/registry.ts` | Cancel on pod A cannot reach a turn on pod B. Also feeds `isBusy` for project close/delete and the reaper, so both go blind. |
| `TurnRateLimiter` ×2 | `apps/api/src/turns/rate-limiter.ts` | N pods = N× the limit. Free-tier spend multiplies by replica count. |
| Reaper `setInterval` | `apps/api/src/compose.ts:283` | N pods = N concurrent sweeps tearing the same project down twice. |
| `ChromePageCapture` | `apps/api/src/boot.ts` | One Chromium per process; ~1GB of image and a RAM spike per capture. Bounded by `BoundedPageCapture` since B-6. |
| DB pool `max: 10` | `packages/db/src/client.ts:25` | Sized for one process doing everything. |
| Sandbox quota TOCTOU | `apps/api/src/turns/sandbox-quota.ts` | Count-then-create. At 100 concurrent admissions the global cap is guaranteed to overshoot. |

Also constraining pod design: **API pods still talk to E2B.** `GET /sessions/:id/files/*` reads from
the sandbox directly (`apps/api/src/files/routes.ts:94`). Stateless does not mean sandbox-free.

### Deployment today

One Railway container, `numReplicas: 1` pinned in `railway.json`, Neon Postgres, R2, E2B,
OpenRouter. `docs/DEPLOY.md` documents the one-replica rule and *why* — every reason in it is one of
the rows above, and retiring that rule is the last step of §19.

---

## 2. Glossary additions

**`Job` is taken.** `CONTEXT.md:22` defines a Job as one objective — the durable unit that outlives a
turn, opened by `job.started`, closed by `job.completed`, folded from the log. **A queue row is never
called a Job.**

To be written into `CONTEXT.md` when implementation begins:

- **Turn request** — a durable, queued intent to execute. Created by an API pod at admission,
  claimed by exactly one worker, terminal exactly once. It is *not* a Job: one turn request may
  drive a Job through several Turns (the prompt and its repairs). Its `kind` is `turn` or `resume`.
- **Lease** — a worker's time-bounded, exclusive claim on a session. What replaces `SessionQueue`.
  Held by at most one worker per session, cluster-wide, and enforced by a partial unique index
  rather than by application logic.
- **Fanout** — delivery of an already-persisted event to whichever API pods hold subscribers for its
  session. Strictly after the append, as today. A notification is a wake-up signal; the durable log
  is the delivery.

---

## 3. Proposed architecture

```
                      Ingress (WS upgrade, 3600s read timeout)
                                   │
                     ┌─────────────┴─────────────┐
                     │  Service: nap-api         │
                     └─────────────┬─────────────┘
                                   │
        ┌──────────────┬───────────┴───────────┬──────────────┐
   nap-api pod    nap-api pod             nap-api pod    …  (HPA 3–12)
   HTTP + WS      HTTP + WS               HTTP + WS
        │
        │ admission (advisory quota, rate, model access) → enqueue
        │ LISTEN nap_events → read log → socket
        ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                        Postgres (Neon)                        │
  │  events (authoritative log)   turn_requests (queue + leases)  │
  │  sandbox_reservations         turn_rate_events                │
  │  projects / sessions / snapshots                              │
  └──────────────────────────────────────────────────────────────┘
        ▲
        │ claim (SKIP LOCKED + partial unique) │ append → publish(NOTIFY)
        │
  nap-worker pod   nap-worker pod   …  (KEDA 2–25, concurrency N each)
   SingleAgentRuntime
        │
        ▼
     E2B sandboxes          OpenRouter          R2 (snapshots, thumbnails)

  nap-reaper (replicas: 1, advisory-lock guarded)
```

Three deployments, one database. **No Redis, Kafka, NATS, service mesh, or additional
microservices.** The permitted component list is exactly: API pods, worker pods, reaper, Postgres,
E2B, OpenRouter, R2, `pg_notify`, Kubernetes, k6.

**Why Postgres for the queue.** Postgres stays authoritative. A separate broker would make the queue
a *second* source of truth about what is running, which then has to be reconciled with the event log
— and the event log wins every such argument, because `foldJobs` is what decides what an interrupted
Job needs. `SELECT … FOR UPDATE SKIP LOCKED` is transactional with the log and is one fewer component
to run, secure and pay for.

---

## 4. API vs worker responsibilities

| | **API pod** | **Worker pod** |
|---|---|---|
| Owns | HTTP, WebSocket, auth, project CRUD, file reads, thumbnails, health | Executing Turns |
| Turn path | Validate → resolve model access → rate limit → **advisory** quota check → allocate `turnId` → `INSERT turn_request` → 202 | Claim lease → reserve capacity → `SingleAgentRuntime` → settle → release |
| Open path | `INSERT turn_request(kind='resume')` → 202 | Claim lease → `resumeSession` → `continuationFor` |
| Event path | `LISTEN` → read log → send on sockets | Append → publish (NOTIFY) |
| Talks to E2B? | Yes, read-only: file reads | Yes, everything |
| Talks to model? | No | Yes |
| Stateless? | Yes — **no session affinity required** | Yes; its leases live in Postgres |
| Scales on | WebSocket connections | Queue depth |

The API's `Runtime` dependency **disappears**. `registerTurnRoutes` and the project-open route take a
`TurnRequestQueue` instead. `resolveTurnAccess` and the rate limiter stay where they are — admission
is the API's job and always was.

**`SingleAgentRuntime` barely changes.** It already takes an `AbortSignal`, already serializes per
session, already appends-then-publishes. What changes is who calls it, what the `EventBus` is made
of, and where the per-session lock lives.

---

## 5. Queue semantics

```sql
create type turn_request_state as enum ('queued','leased','done','failed','orphaned');
create type turn_request_kind  as enum ('turn','resume');

create table turn_requests (
  -- Also the first logical Turn's turnId. See §6.
  id            uuid primary key,
  session_id    uuid not null references sessions(id) on delete cascade,
  user_id       uuid not null references users(id)    on delete cascade,
  kind          turn_request_kind  not null,
  state         turn_request_state not null default 'queued',
  message       text,                       -- null for kind='resume'
  model         text not null,
  -- Never a key. The worker re-opens the caller's stored key by user_id, so plaintext
  -- credentials never touch this table, a query log, or a backup.
  bills_to_user boolean not null default false,
  cancel_requested boolean not null default false,
  lease_owner      text,
  lease_expires_at timestamptz,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

-- The distributed SessionQueue. One in-flight request per session, cluster-wide,
-- enforced by the database rather than by every caller remembering.
create unique index turn_requests_one_leased_per_session
  on turn_requests (session_id) where state = 'leased';

create index turn_requests_queued on turn_requests (created_at) where state = 'queued';
create index turn_requests_lease_expiry on turn_requests (lease_expires_at) where state = 'leased';
```

**Claim**, run by a worker with a free concurrency slot:

```sql
update turn_requests set
  state = 'leased', lease_owner = $1,
  lease_expires_at = now() + interval '60 seconds',
  started_at = coalesce(started_at, now())
where id = (
  select id from turn_requests
  where state = 'queued' and not cancel_requested
  order by created_at
  for update skip locked
  limit 1
)
returning *;
```

A unique violation (`23505`) on `turn_requests_one_leased_per_session` means another worker holds
that session — skip it, try the next candidate. **The constraint is the mechanism, not a backstop**,
the same posture the repo already takes with `unique(session_id, seq)`.

There is **no `attempts` column and no requeue path.** A request is claimed at most once. That is
§6's at-most-once execution guarantee, expressed in the schema.

### Lease renewal and fencing

Lease expiry does not, by itself, stop a worker. A worker can lose its lease while still alive — a
long GC pause, a Postgres blip, a partition — and would then keep appending to a session another
worker could claim. **Renewal is therefore conditional, and losing it is fatal to the turn.**

```sql
update turn_requests set
  lease_expires_at = now() + interval '60 seconds'
where id = $1 and lease_owner = $2 and state = 'leased'
returning cancel_requested;
```

**Zero rows returned means the lease is lost. The worker aborts its `AbortController` immediately
and stops appending.** The same statement returns `cancel_requested`, so one query serves both
renewal and cancellation.

| Parameter | Value | Purpose |
|---|---|---|
| `lease_expires_at` | now + 60s | tolerates three missed renewals |
| renewal interval | 15s | worker detects loss within 15s of expiry |
| **janitor grace** | expiry + 30s | the fencing margin — the row becomes reclaimable only *after* the worker has aborted |

The 15-second margin between "worker has certainly aborted" (≤ expiry+15s) and "janitor acts"
(expiry+30s) is what makes two concurrent writers to one session unreachable.

### Orphaning

At `lease_expires_at + 30s` the janitor (in the reaper pod) marks the request `orphaned` and, under
the request's own `turnId`, appends:

- `turn.failed { reason: "internal", message: "…interrupted…" }` — so the chat pane shows a terminal
  state instead of spinning forever. `openEventStream` has no timeout; without this the client waits
  on an event that will never come.
- `system.notice { level: "warning", text: "…reopen the project to resume…" }`

**The Job is left open. No `job.completed` is written.** Recovery is §6's continuation path,
triggered by a human.

**Orphaning and announcing are two steps, because they are two systems.** One is a row in
Postgres and the other is an append plus a fanout, and no transaction spans them. The row is taken
first — an `update … where state = 'leased' and lease_expires_at < now() - grace … for update skip
locked`, which is what makes it exclusive between janitors — and `finished_at` is set only once
the events are durable. An `orphaned` row with a null `finished_at` is a request whose terminal
events are still owed, and the next tick finds it and finishes. The other order would leave, on a
crash in between, exactly the state invariant 15 forbids.

---

## 6. Turn-request identity, and the execution guarantee

> **Queue delivery may be at-least-once. Logical Turn execution is at-most-once.**

That is a stronger and simpler guarantee than "idempotent retry", and it is affordable only because
`foldJobs` makes a partial log a first-class input rather than an error.

**`turn_requests.id` is the first logical Turn's `turnId`.** One uuid, allocated by the API pod at
admission, durable before any execution.

| Question | Answer |
|---|---|
| **When is Turn identity created?** | At admission on the API pod, before the `INSERT` — and `turn_requests.id` carries **no database default**, so a caller that forgot to allocate one gets a not-null violation rather than a row naming a Turn no log contains. It used to be created inside the runtime (`this.#newTurnId()`) and was therefore unknowable to anything that did not run the turn. |
| **How does it map?** | `turn_requests.id == events.turn_id` of the request's *first* Turn. `turnId` is a field on `TurnRequest` and on `ContinueOptions`, threaded through the runtime entry points. `newTurnId` remains, for repairs only. |
| **Worker dies after appending events, before settling?** | The log holds `turn.started` / `user.message` / `job.started` under that turnId. The row stays `leased` until expiry, then `orphaned`. **Never requeued**, so a second execution of that request is unreachable by construction. |
| **How does a continuation know the Turn already exists?** | It does not need to. Continuation never re-runs a request; it folds the log and asks `continuationFor` what the *Job* needs. The turnId is used by the janitor, to close the right Turn. |
| **Repair Turns?** | Distinct `crypto.randomUUID()` per repair, still generated in the worker. A repair is a distinct Turn (ADR-0006); it shares the request's lease, not its id. The repair budget is counted from `verification.started` in the log (`job-state.ts:99`), so it survives worker death without resetting. |
| **Resume requests?** | Same rule — `request.id` is the resume's first turnId, which is what `#resumeLogged` currently generates for itself. |

### Continuation is a queued resume request

**`POST /projects/:id/open` must never call `resumeSession` in the API process.** It inserts a
`turn_request(kind='resume')` and answers 202.

If it stayed as it is (`projects/routes.ts:208`), continuation would execute *without a lease*,
concurrently with a worker turn on the same session — precisely the two-sandbox failure the lease
exists to prevent. **Resume acquires the same per-session lease as any other request.**

The full recovery path:

```
leased ──renewal returns 0 rows──► worker self-aborts (≤ expiry+15s)
           │
           └── janitor at expiry+30s ──► orphaned
                       │ appends turn.failed + system.notice under request.id
                       │ Job stays OPEN
                       ▼
           human: POST /projects/:id/open
                       ▼
           INSERT turn_request(kind='resume')  ← new id, new turnId
                       ▼
           worker claims lease → resumeSession → continuationFor(foldJobs(log), { workspaceHeadSha })
                       ▼
                 none │ close │ verify │ repair
```

**Nothing on this path spends a token without a human present.** That is `CONTEXT.md`'s *Continue*
principle and `single-agent-runtime.ts:270` — *"an autonomous loop that spends tokens with nobody
watching is a bill, and a crash loop plus auto-continue is a large one"* — carried into a
distributed system unchanged.

Two consequences the design did not anticipate, both recorded in `docs/GOTCHAS.md` (API section):
the row carries a concrete model, so **an open can now be refused for a model nobody asked for**;
and an orphaned `resume` is announced with the `system.notice` alone, since opening a project
starts no turn for a `turn.failed` to close.

---

## 7. Atomic sandbox admission

A correctness requirement, not a performance optimisation. The current check is count-then-create
(`sandbox-quota.ts:48`) and will overshoot the global cap under 100 simultaneous admissions — and
the global cap is the only thing bounding total E2B burn.

Two changes from the first draft:

**(a) The authoritative reservation happens in the worker, immediately before `sandbox.create()`.**
Not at API admission: a request can sit queued for a minute, and a reservation taken at admission
would either expire before use or hold capacity for work that has not started. The API keeps a cheap
count so the obvious case still gets a fast `409` — **advisory only, and commented as such.**

**(b) Durable reservation rows, not a bare counter.** A counter cannot be reconciled: it cannot
distinguish a leaked increment from an in-flight creation. Rows can.

```sql
create table sandbox_reservations (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  state      text not null,               -- 'reserved' | 'active'
  sandbox_id text,                        -- null while 'reserved'
  created_at timestamptz not null default now(),
  expires_at timestamptz not null         -- 'reserved' only; now() + 2 min
);

create unique index sandbox_reservations_one_per_project
  on sandbox_reservations (project_id) where state in ('reserved','active');
```

### Exact transaction boundary — three transactions, deliberately

```
TXN 1 (reserve; commits before any E2B call)
  pg_advisory_xact_lock(SANDBOX_CAPACITY_KEY)          ← serializes all admissions
  select count(*) where state in ('reserved','active')
    → if >= NAP_MAX_SANDBOXES_TOTAL: abort, refuse
  select count(*) where user_id = $1 and state in ('reserved','active')
    → if >= per-user cap: abort, refuse
  insert (project_id, user_id, 'reserved', now() + '2 minutes')
COMMIT                                                  ← capacity is now consumed

  ── no lock held ──   sandbox.create()   (seconds, network)

TXN 2 (activate)
  update sandbox_reservations set state='active', sandbox_id=$1, expires_at='infinity'
  update sessions set sandbox_id=$1
COMMIT

TXN 3 (release; on any failure, and on teardown)
  delete from sandbox_reservations where id = $1
COMMIT
```

The advisory lock rather than `SERIALIZABLE`: it matches the idiom already in
`postgres-event-store.ts:58`, needs no retry loop, and the critical section is two counts and an
insert — sub-millisecond. 100 burst admissions serialize in well under a second, invisible beside a
3-second sandbox cold start.

**The cap is enforced on the reservation, before creation, so it is never exceeded — only ever
temporarily under-used.** That is the correct direction for a limit whose job is to cap a bill, and
it matches the reasoning already in `sandbox-quota.ts:19`.

### Failure boundaries and reconciliation

| Failure | Immediate behaviour | Heals by |
|---|---|---|
| Reserved, E2B create fails | TXN 3 deletes the row; turn fails `sandbox_unavailable` | immediate |
| **Process dies after TXN 1, before create** | Row stays `reserved`; capacity held | reaper deletes `reserved` rows past `expires_at` — ≤2 min |
| **Create succeeds, TXN 2 fails** | Sandbox exists; the project names no sandbox; row still `reserved`. **A sandbox nobody can find.** | reaper lists E2B sandboxes and destroys any whose id appears in no `projects.sandbox_id` — new machinery, required |
| Sandbox destroyed out-of-band (E2B reclaim, provider TTL) | Row stays `active`; capacity held | reaper deletes `active` rows whose `sandbox_id` is absent from `projects.sandbox_id` |

### Consequence for component ownership

This moves the authoritative capacity check out of `apps/api/src/turns/sandbox-quota.ts` and into the
creation path in `packages/runtime/src/acquire-sandbox.ts`, behind a new **`SandboxCapacity` port**
implemented in `@nap/db`.

**`CLAUDE.md`'s component-ownership table contradicts this as written** and must be updated — the
`Runtime` row gains authoritative sandbox capacity reservation, and the note that quota checks belong
at the route becomes "rate and model access at the route; sandbox capacity at the point of creation".

That edit is deliberately **not** made yet. `CLAUDE.md` must describe reality, and the port does not
exist. It lands with migration step 3 (§19).

---

## 8. Event fanout

`InProcessEventBus` is replaced by **`PostgresNotifyEventBus`**, implementing the existing `EventBus`
port. Nothing above the port changes; `openEventStream`, `EventSink` and `SingleAgentRuntime` are
untouched.

1. The worker appends. `EventSink` then calls `bus.publish(stored)` — the existing, documented
   append-then-publish call site (`event-sink.ts:57`).
2. `publish()` emits **only** `pg_notify('nap_events', '{"sessionId":…,"seq":…}')`. **Never a
   payload.**
3. Each API pod holds one `LISTEN nap_events` connection.
4. On a notification for a session it has subscribers for, the pod calls
   `store.readFrom(sessionId, cursor)` — reading from the durable log — and hands rows to
   subscribers.
5. Each socket's existing `lastSentSeq` gate drops anything already sent.
6. **A catch-up poll every 2s** for sessions with an open Job runs the same read unconditionally.

**A notification is a wake-up signal. The durable log is the delivery.** The poll is the backstop
that makes that literally true, not a decoration.

### Why `publish()` and not inside `append()`

The first draft proposed emitting NOTIFY inside the append transaction. **Keeping the catch-up poll
reverses that decision**, because the only thing in-transaction bought was closing the
commit-to-notify crash window, which the poll closes anyway.

| Criterion | Inside `append()` txn | `PostgresNotifyEventBus.publish()` |
|---|---|---|
| Append-before-publish preserved | Yes, structurally | **Yes** — `publish()` is only reachable after `append()` returns, and `append()` returns only on commit |
| No notification for a rolled-back transaction | Yes | **Yes** — a rollback throws out of `append()`; `EventSink` records the failure and stops the chain (`event-sink.ts:65`), so `publish()` is never called |
| Minimal duplication of responsibility | **No** — the store takes on fanout signalling; `EventBus.publish` becomes a no-op on workers, leaving `EventSink`'s publish call reading as dead code | **Yes** — one new class implementing an existing port. `EventStore` and `EventBus` responsibilities stay separate |
| Smallest architecture change | No — changes the store, the port's meaning, and the ordering rule documented in `event-sink.ts` | **Yes** — one swapped implementation at boot |

**Explicit trade-off:** a worker that dies between the append committing and `pg_notify` firing
leaves an event durable but unannounced. **The event is never lost.** Clients see it within one poll
interval (≤2s), or immediately on the next event for that session. We accept ≤2s of added latency on
a rare crash path in exchange for leaving the store, the sink and the port exactly as they are.

### Two operational constraints

- **The 8000-byte NOTIFY payload cap** is why only `{sessionId, seq}` travels. Nap events carry
  command output and file contents; a payload-carrying design would fail on exactly the largest
  events.
- **LISTEN needs a session-mode connection.** It cannot go through PgBouncer in transaction mode or
  Neon's pooled endpoint. Each API pod opens *one* direct connection for LISTEN and uses the pooled
  endpoint for everything else. Advisory *xact* locks work fine through a transaction pooler; a
  session-level lock would not, which is another reason this design uses none.

---

## 9. Cancellation across pods

1. Authorize the session (unchanged — `findOwnedSession` first, so a 409 cannot leak whether a
   stranger's session is busy).
2. `update turn_requests set cancel_requested = true where session_id = $1 and state in
   ('queued','leased') returning state`. No row → `409`, exactly as today.
3. A `queued` row is never claimed — the claim query already excludes `cancel_requested`.
4. A `leased` row: `pg_notify('nap_cancel', request_id)`. The owning worker listens and aborts its
   local `AbortController`.
5. If the notification is missed, the next lease renewal (≤15s) returns `cancel_requested = true`
   and the worker aborts.

`TurnRegistry` survives, unchanged in shape, but moves to the worker and is keyed by **request id**.
Its own doc comment predicted this: *"the honest fix for that is a cancellation signal in the
database rather than a shared map."*

`isBusy` — used by project close, project delete and the reaper — stops reading the registry:

```sql
select exists (
  select 1 from turn_requests where session_id = any($1) and state = 'leased'
);
```

One query, cluster-wide, so "busy" keeps meaning one thing everywhere — which was the point of
sharing the registry in the first place.

**Bound: cancellation reaches an executing turn within one renewal interval (≤15s), typically in
milliseconds.**

---

## 10. WebSocket clients across replicas

**No sticky sessions, no session affinity, no shared socket registry.** This already works and it is
the nicest property in the codebase.

A client reconnecting after a pod dies, a rollout or a blip opens `/ws?sessionId=…&seq=N` against
whichever pod the Service picks. That pod subscribes, reads `readFrom(sessionId, N)`, sends exactly
the gap, flushes anything buffered during the read, then tails. Ordering comes from gapless `seq`;
duplicates are impossible because of the `lastSentSeq` gate; and the pod that *produced* the events
was never the pod serving the socket anyway.

Ingress requirements:

- WebSocket upgrade; `proxy-read-timeout: "3600"`, `proxy-send-timeout: "3600"`. The app pings every
  30s and times out at 150s (`DEFAULT_HEARTBEAT`), so the ingress must be more patient than the app.
- `terminationGracePeriodSeconds: 30` on API pods. Cosmetic only — clients reconnect with `seq`.
- The session cookie is already cross-site (`SameSite=None; Secure`). Putting the API on a subdomain
  of the web app makes `isCrossSite` false and fixes the Safari/Brave sign-in bug (issue #61) with no
  code change. Worth taking while DNS is being touched.

---

## 11. How Postgres stays authoritative

| Fact | Now | After |
|---|---|---|
| What happened in a session | `events` | unchanged |
| What a Job's phase is | derived by `foldJobs` | unchanged |
| Which commit is a checkpoint | `job.checkpointed` in the log | unchanged |
| Which project has which sandbox | `projects.sandbox_id` | unchanged |
| Which turns are pending/running | **memory** (`SessionQueue`) | `turn_requests` |
| Who may cancel what | **memory** (`TurnRegistry`) | `turn_requests.cancel_requested` |
| How fast a user may spend | **memory** (`TurnRateLimiter`) | `turn_rate_events` |
| How many sandboxes are live | non-atomic count | `sandbox_reservations` + reconciliation |

Nothing new becomes authoritative. Three things that were memory become rows.

The rate limiter keeps its exact sliding window and exact `Retry-After` — one row per **accepted**
turn in `turn_rate_events(user_id, at, tier)`, counted inside the admission transaction, swept by the
reaper. This preserves the property the current implementation was careful about: **a refused attempt
records nothing**, so a retrying client's recovery never recedes.

---

## 12. Health endpoints

`/health` answers **200 even when degraded**, deliberately (`docs/DEPLOY.md`: *"a non-2xx is how a
platform decides to restart or de-register a process, and neither helps when the thing that is down
is Postgres"*). That reasoning is right for liveness and wrong for readiness: a pod that cannot reach
Postgres *should* leave the Service, because another pod can serve.

| Endpoint | Semantics | Used by |
|---|---|---|
| `/livez` | 200 unless the process is wedged. **Never touches Postgres.** | k8s livenessProbe |
| `/readyz` | 503 when Postgres is unreachable or the LISTEN connection is down | k8s readinessProbe |
| `/health` | **Unchanged**, body-readable, degraded-but-200 | humans, `curl`, `docs/DEPLOY.md` |

Three concerns that are currently one endpoint. Pointing a k8s probe at the existing one would either
flap every pod during a Neon blip, or route traffic to pods that cannot serve.

---

## 13. Kubernetes objects

```
namespace/nap

deployment/nap-api          replicas 3 (HPA 3–12)
  RollingUpdate maxSurge=1 maxUnavailable=0
  terminationGracePeriodSeconds: 30
  readinessProbe  GET /readyz     livenessProbe  GET /livez
  resources: requests 250m/512Mi, limits 1000m/1Gi
service/nap-api             ClusterIP
ingress/nap                 WS upgrade, 3600s timeouts, TLS
poddisruptionbudget/nap-api minAvailable: 2

deployment/nap-worker       replicas 2 (KEDA 2–25)
  no Service — nothing connects to a worker
  terminationGracePeriodSeconds: 900
  NAP_WORKER_CONCURRENCY (start at 5; set by measurement)
  NAP_CAPTURE_CONCURRENCY=1        ← see B-6
  resources: requests 500m/1Gi, limits 2000m/3Gi   (Chromium spikes)
  livenessProbe: exec, "has the claim loop ticked in 120s"
poddisruptionbudget/nap-worker maxUnavailable: 1

deployment/nap-reaper       replicas 1, strategy Recreate
  additionally guarded by pg_try_advisory_lock so a rollout overlap cannot double-sweep
  owns: idle sweep, lease janitor, reservation reconciliation, rate-event sweep

configmap/nap-config        every NAP_* tunable
secret/nap-secrets          DATABASE_URL, E2B_API_KEY, OPENROUTER_API_KEY,
                            BETTER_AUTH_SECRET, NAP_KEY_ENCRYPTION_SECRET, R2_*
serviceaccount/nap          no RBAC — leader election is an advisory lock, not a k8s Lease
hpa/nap-api                 autoscaling/v2
scaledobject/nap-worker     KEDA, postgresql scaler
networkpolicy/nap           egress to Postgres, E2B, OpenRouter, R2 only
job/nap-migrate             `bun run db:migrate`, run deliberately — never at pod boot
```

---

## 14. Scaling signals

**Workers scale on queue depth, via KEDA's built-in `postgresql` scaler.** Plain HPA cannot read
Postgres, and CPU is a bad proxy: a turn is almost entirely network wait on the model and the
sandbox, so five concurrent turns can sit at 15% CPU.

```
query:            select count(*) from turn_requests where state in ('queued','leased')
targetValue:      NAP_WORKER_CONCURRENCY
minReplicaCount:  2
maxReplicaCount:  ceil(NAP_MAX_SANDBOXES_TOTAL / NAP_WORKER_CONCURRENCY)
cooldownPeriod:   300
```

`maxReplicaCount` is derived from the sandbox cap on purpose: **Kubernetes must not be able to outrun
the thing that bounds the bill.**

**API pods scale on WebSocket connections**, not CPU — an idle socket costs a file descriptor and a
subscription, and 500 of them can sit near zero CPU while the pod is at its practical limit. Custom
metric `nap_ws_connections` via Prometheus + prometheus-adapter, target ~200/pod, with CPU at 70% as
a secondary trigger.

**Scale-down must not kill turns.** `behavior.scaleDown.stabilizationWindowSeconds: 600`, plus
draining (§15). A worker scaled down mid-turn is the same event as a crash, and §6 says that costs a
human a reopen — so scale-down should be lazy and rare.

---

## 15. Graceful shutdown and draining

Worker, on `SIGTERM`:

1. Stop claiming. The claim loop exits immediately.
2. Let in-flight turns finish, up to `NAP_DRAIN_TIMEOUT_SECONDS` (600s), inside the 900s grace
   period. (Shipped under that name; this section said `NAP_DRAIN_TIMEOUT` before it was built.)
3. **Keep renewing leases** of turns still running, so the janitor does not orphan progressing work.
4. On completion, settle each request and release its lease.
5. If the drain timeout expires: abort remaining turns via their `AbortController`. A cancelled turn
   commits nothing and closes the Job `abandoned` — a clean stop, not a kill. Then exit.

Sizing: a turn is 8–43s (`docs/napbench-first-real-run.md:159`), but a Job with verification and
three repairs is minutes. 900s covers the tail.

API, on `SIGTERM`: stop accepting, close sockets with a normal close code, exit within 30s. Clients
reconnect with `?seq=` and lose nothing.

The signal handler is `bootNap`'s (`apps/api/src/boot.ts`), so both processes shut down through
one sequence and neither can forget a piece the other stops.

---

## 16. Cost control

- **Ceilings become cluster-wide and atomic** (§7). `NAP_MAX_SANDBOXES_TOTAL` is the hard bound.
- **`maxReplicaCount` is derived from that cap**, so no autoscaler decision can exceed it.
- **The k6 proof costs nothing.** Fake `SandboxManager` and fake `LLMProvider`, latency calibrated
  from `docs/napbench-first-real-run.md` (turn 8–43s, sandbox cold start ~3.0s, preview render 2.4s).
  What is measured is the layer that was single-process; E2B and OpenRouter concurrency are vendor
  quota questions, not Nap architecture questions.
- **Production ceilings are not raised.** The harness composes its own.
- A separate assertion covers the ceiling path: at `NAP_MAX_SANDBOXES_TOTAL=10`, requests 11+ get a
  clean `409` with no half-created sandbox, no leaked reservation and no stuck lease.
- One optional funded confirmation run at low n, after the shape is proven free.

---

## 17. Contradictions and risks found in review

Each must be resolved before or during implementation. None is speculative; each was found by reading
the code.

### B-1 — a commit can exist that the log does not know about *(most serious)*

`foldJobs` derives `headSha` **only** from `turn.completed.commitSha` or `job.checkpointed`
(`job-state.ts:126–142`). The commit itself happens earlier, inside `finalize`
(`single-agent-runtime.ts:754`), and the sha reaches the log only when the agent emits
`turn.completed`.

A worker dying in that gap leaves a real git commit in the sandbox and a log saying nothing was
committed. `continuationFor` reads `commitSha === null` and returns `{kind:'close', outcome:
'unverified'}` (`continue-job.ts:105`). **The commit is never verified and never checkpointed** — the
work survives in the snapshot but is permanently outside the verification loop.

This exists today, but needs a restart mid-turn. With 20 worker pods and rolling updates it becomes
routine.

**Resolution — keep `continuationFor` pure, give it one more input:**

```ts
continuationFor(state: SessionJobs, evidence: { workspaceHeadSha: string | null }): JobContinuation
```

On resume the worker restores the project and reads `git rev-parse HEAD`. If the log has no
`commitSha` for the interrupted Turn but `workspaceHeadSha` differs from `checkpointSha`,
continuation returns `kind:'verify'` **against the real HEAD**. No new event type, no change to the
event contract, and it stays a pure function testable with a literal array. Regression tests in §20.

> **As shipped, HEAD wins wherever it could be read** — not only where the log records no commit.
> The narrower rule leaves a second copy of the same bug one level down: a repair turn that commits
> and dies before saying so has a `headSha` in the log from the turn *before* it, so continuation
> would checkpoint that older sha while the checks ran against the newer tree. A checkpoint is a
> commit verification agreed with, and verification runs in the workspace, so the workspace's HEAD
> is the only sha that claim can honestly name. The cost of the wider rule is that a project
> restored from a snapshot older than a recorded commit checkpoints the older sha — which is, again,
> the one that was checked. `workspaceHeadSha === null` falls back to the log in both readings.

### B-3 — `EventSink` append failure is sticky and fatal

`#failure` is sticky and `drain()` throws (`event-sink.ts:66–74`). On one replica against Neon that
is rare. At 100 concurrent turns through a pooled endpoint, transient errors are routine, and each
one kills a whole turn — including its repair budget.

**Resolution — a bounded retry inside the append, specified now, implemented at step 5:**

- **3 attempts**, exponential backoff **100ms / 400ms / 1600ms**, ±25% jitter.
- Retry **only** on transient classes: connection failure, `40001` serialization failure, `40P01`
  deadlock, `57P01` admin shutdown, pool timeout. **Never** on `23505` (unique violation), `23503`
  (foreign key), or a Zod parse failure — those are programmer error or corruption and must stay
  fatal.
- After 3 attempts the sink fails exactly as it does today: sticky failure, `drain()` throws, turn
  fails, nothing commits.

> **Retries must never duplicate an event.** The retried statement is the single-statement insert in
> `PostgresEventStore.append`, whose transaction either commits or does not. A retry after a
> *successful* commit whose acknowledgement was lost would insert a second row with a fresh `seq` —
> so a retry must first re-read `max(seq)` for the session under the same advisory lock and abort if
> the intended event is already present. `unique(session_id, seq)` is the backstop that turns any
> remaining race into a hard error rather than a duplicated message in somebody's chat.

### B-4 — `NAP_MAX_SANDBOXES_TOTAL` is documented as per-process

`sandbox-quota.ts:28` says *"Across everybody in this process."* After scaling it is **cluster-wide**.
Someone sizing the cap by replica count would multiply the bill. The comment, `apps/api/.env.example`
and `docs/DEPLOY.md`'s "What a public URL costs" section all need correcting at step 3.

### B-5 — `TurnRegistry.start()`'s defensive abort becomes unreachable

It aborted a pre-existing controller for the same session. On a worker keyed by
**request id**, with `turn_requests_one_leased_per_session` guaranteeing one leased request per
session and the fencing rule (§5) guaranteeing the previous worker has aborted, that branch cannot be
entered.

**Removed**, and documented in `registry.ts` — with a test that asserts the *absence*, since the
repo's own rule is that a check which has never been
observed failing is not known to work, and a guard nobody can trigger is worse than no guard — it
implies a race that the schema has already made impossible.

### B-6 — thumbnail capture concurrency is not worker concurrency

`#photograph` runs after every committed turn. At `NAP_WORKER_CONCURRENCY=5` that is up to five
simultaneous Chromium page loads in one pod.

**Resolution: a per-worker semaphore, `NAP_CAPTURE_CONCURRENCY=1`.** One capture at a time per
worker unless measurement proves more is safe. Capture is already best-effort — a failure is only a
log line (`single-agent-runtime.ts:1013`) — so queueing behind a semaphore costs nothing a user can
see, while five Chromiums in a 3Gi pod is an OOMKill.

---

## 18. State machines

### Turn request

```
                  ┌──────────┐
   admit ───────► │  queued  │
                  └────┬─────┘
                       │ claim (SKIP LOCKED + partial unique index)
                       ▼
                  ┌──────────┐
                  │  leased  │─────── settle ok ──────► │   done   │  terminal
                  └────┬─────┘                          └──────────┘
                       ├─── turn failed / cancelled ───► │  failed  │  terminal
                       └─── lease lost, janitor @ ──────► │ orphaned │  terminal
                            expiry + 30s
```

**There is no edge back to `queued`.** Lease loss never requeues. That is decision 1, expressed as a
state machine, and it is the reason execution is at-most-once.

### Lease

```
none ──claim──► held ──renew every 15s──► held ──release──► none
                 │
                 └── renewal returns 0 rows ──► LOST ──► worker aborts its turn immediately
```

`held` is unique per session cluster-wide, enforced by `turn_requests_one_leased_per_session`.
Renewal is conditional on `id = $1 and lease_owner = $2 and state = 'leased'`.

### Turn

Unchanged — the event log *is* the state machine.

```
turn.started ──► [tool.call / assistant.delta / …] ──► turn.completed{commitSha}
                                                    └► turn.failed{reason}
```

No terminal event means an interrupted Turn. The janitor writes one on orphaning (§5), so no Turn
stays open forever and no chat pane spins forever.

### Job

Unchanged — `foldJobs` + `phaseOf` (`job-state.ts:222`).

```
job.started ──► working ──(verification.started)──► verifying
                                                       │
                            green ──────────────────► verified
                            red, attempts left ─────► repairing ──(repair Turn)──► verifying
                            red, budget spent ──────► exhausted
                            crash / cancel / error ─► abandoned
                            nothing committed ──────► unverified
```

Open phases: `working`, `verifying`, `repairing`. A crash leaves a Job in one of them, and
`continuationFor` maps each to `none` / `close` / `verify` / `repair`. **Nothing here changes**, and
that is why the whole design is affordable.

---

## 19. Failure and recovery paths

| Event | What happens | Recovery | Bound |
|---|---|---|---|
| **Worker crash** | Lease stops renewing. Turn dies mid-log, no terminal event. | Janitor at expiry+30s → `orphaned`, appends `turn.failed` + `system.notice` under `request.id`. Job stays open. A human's project-open enqueues a `resume`; `continuationFor` decides. Sandbox reaped on idle. | ≤90s to visible; human-triggered to resume |
| **API crash** | Sockets drop. No turn is affected — the API executes nothing. | Clients reconnect to any pod with `?seq=N`; `readFrom` sends exactly the gap; `lastSentSeq` prevents duplicates. | client backoff |
| **Postgres outage** | Appends fail → bounded retry (B-3) → if exhausted, turn fails cleanly. Admissions refused. `/readyz` 503s, pods leave the Service. | Nothing commits. Jobs stay open; reopening resumes. LISTEN reconnects; the catch-up poll repairs the gap. | retry budget ~2.1s; poll 2s |
| **E2B creation fails** | `acquireSandbox` returns a typed failure → `turn.failed{sandbox_unavailable}` (existing path). | Reservation released in TXN 3; capacity returns immediately. | immediate |
| **Sandbox loss** (E2B reclaim / TTL) | `resume` fails → `acquireSandbox` restores from snapshot and prepends `LOST_SANDBOX_WARNING` (`acquire-sandbox.ts:70`). Unchanged. | Reservation reconciled by the reaper. | ≤ reaper interval (60s) |
| **WebSocket disconnect** | Subscription and heartbeat released via `onClose` / `onError`. | Reconnect with the highest `seq` seen, to any pod. No affinity. | client |
| **Kubernetes scale-down** | SIGTERM → stop claiming → drain ≤600s → abort the remainder → exit ≤900s. | An aborted turn commits nothing and closes the Job `abandoned` — a clean stop. Leases released explicitly. | 900s grace; 600s scale-down stabilization makes it rare |

---

## 20. Migration sequence

The constraint: **every step leaves single-replica Nap working and green.** No step is a cutover.
Steps 1–9 all ship to the current Railway deployment unchanged.

| # | Step | Processes after | Proves |
|---|---|---|---|
| 0 | `packages/loadgen` + k6 script + fake-composed harness. Baseline the **current** single process at 10→100. | 1 | The measurement exists before any change, so every later step has a before |
| 1 | `/livez` + `/readyz`; `/health` untouched | 1 | Probes, in isolation |
| 2 | `PostgresNotifyEventBus` + catch-up poll, behind an env switch defaulting to in-process | 1 | Fanout works with one pod, where it is trivially verifiable |
| 3 | `sandbox_reservations` + `SandboxCapacity` port; worker-side reservation; API check demoted to advisory. **`CLAUDE.md` ownership table + B-4 wording corrected here.** | 1 | The hard cap holds under concurrent admission |
| 4 | `turn_rate_events` — rate limiting moves to Postgres | 1 | Limits mean the same thing at 1 pod as at 12 |
| 5 | `turn_requests` + leases + janitor + B-3's bounded retry. **Worker loop runs in-process**, so the API still executes turns — but through the queue. | 1 | Queue and lease semantics with no distribution to confuse the diagnosis |
| 6 | `POST /projects/:id/open` enqueues a `resume` request instead of executing | 1 | Continuation takes a lease like anything else |
| 7 | Split the binary: `apps/api` and a worker entrypoint. Both run locally. | 1 + 1 | Nothing in the runtime needed the HTTP process |
| 8 | `isBusy` reads leases; reaper moves to its own process with the advisory-lock guard | 1 + 1 + 1 | Three processes, one machine |
| 9 | Turn identity moves to admission (`turnId` on the ports); janitor orphan handling; B-1's `workspaceHeadSha`; B-5 removal; B-6 semaphore | 1 + 1 + 1 | Decisions 1, 2 and 3, end to end |
| 10 | Kubernetes manifests; deploy; API 3, workers 2 | 3 + 2 + 1 | Multi-pod at low load |
| 11 | HPA + KEDA; the k6 ramp against the cluster | auto | The headline number |
| 12 | Retire the one-replica rule in `docs/DEPLOY.md`; write both ADRs | — | The docs describe reality |

**Two ADRs at step 12** — each is hard to reverse, surprising without context, and the result of a
real trade-off: *turns execute on workers behind a Postgres queue*, and *event fanout is
notify-then-read with the log as the delivery*.

---

## 21. Invariants

Carried forward from v1, unchanged:

1. `seq` is gapless and monotonic per session, under any number of writers.
2. No client is sent an event that is not in the durable log. (Append before publish.)
3. No client is sent the same event twice.
4. A failed, refused or cancelled Turn commits nothing.
5. Only a passing verification checkpoints a commit.
6. The repair budget is 3 per Job, counted from the log, and survives process death without
   resetting.
7. A Job is continued only when a person opens the project. **No autonomous token spend, ever.**

New, and specific to this design:

8. **At most one Turn executes per session, cluster-wide.** *(`turn_requests_one_leased_per_session`)*
9. **At most one sandbox exists per project.** *(follows from 8, plus
   `sandbox_reservations_one_per_project`)*
10. **A worker that has lost its lease performs no further externally-visible action.** It aborts on
    the first renewal returning zero rows, and the janitor's grace window guarantees that happens
    before another worker can claim the request.
11. **A `turn_request` is claimed at most once.** There is no transition back to `queued`.
12. **Queue delivery may be at-least-once; logical Turn execution is at-most-once.** At-least-once
    delivery never produces two logical executions of one Turn, nor two billable sandbox creations
    for one project.
13. **`turn_requests.id` equals the `turn_id` of the request's first logical Turn**, and is allocated
    before the row is inserted.
14. **Every `turn_request` reaches a terminal state** (`done`, `failed`, `orphaned`) within
    `lease_ttl + grace`. Of a request that was *claimed*: a `queued` row has been interrupted by
    nothing and is waiting for a worker, which is the queue working rather than a request stuck,
    and the janitor deliberately leaves it alone.
15. **Every `orphaned` request has a terminal `turn.*` event and a `system.notice` in its session's
    log**, under its own `turnId`. No Turn is permanently invisible; no chat pane spins forever.
16. **Global live sandboxes never exceed `NAP_MAX_SANDBOXES_TOTAL`** — enforced at reservation,
    before creation, so the cap is never exceeded and only ever temporarily under-used.
17. **Capacity is reconcilable.** Every reserved or active row either corresponds to a live sandbox
    or is reclaimed by the reaper within its expiry window.
18. **An event append is retried at most 3 times and never produces a duplicate row.**
19. **Cancellation reaches an executing Turn within one lease-renewal period (≤15s).**
20. **Per-user rate limits mean the same thing regardless of replica count.**
21. **A notification is never required for correctness.** Suppressing `pg_notify` entirely must still
    deliver every event via the catch-up poll.
22. `bun run test`, `bun run typecheck`, `bun run lint` stay green; `test/architecture.ts` learns
    about any new package; nothing outside `apps/napbench` imports `@nap/bench` (ADR-0007).
23. `CLAUDE.md`, `docs/DEPLOY.md` and `CONTEXT.md` describe reality at every step — in particular the
    one-replica rule, every clause of which this design exists to retire.

---

## 22. Tests required before the first 100-user k6 run

**Lease and fencing** *(db suite, real Postgres)*
1. Two concurrent claims for one session → exactly one wins; the loser gets `23505` and is unharmed.
2. 100 concurrent claims across 100 sessions → 100 distinct leases, zero collisions.
3. **Lease-loss self-abort:** renewal after another owner has taken over returns zero rows and the
   worker aborts. *Must be watched failing* — break the `lease_owner` predicate and confirm red.
4. An expired lease is orphaned only after the grace window, never before.
5. An `orphaned` request is never re-claimed.

**Orphan visibility**
6. Orphaning appends a terminal `turn.failed` **and** a `system.notice` under `turnId == request.id`.
7. After orphaning, the Job is still open and `continuationFor` returns a non-`none` continuation.
8. No `turn_request` remains non-terminal past `lease_ttl + grace` — property test over random crash
   points.

**Identity and at-most-once execution**
9. `turn_requests.id` equals the `turn_id` of the first Turn in the log, for both `kind='turn'` and
   `kind='resume'`.
10. A worker killed after `job.started` but before settling leaves exactly one `job.started`;
    reopening produces no second one.
11. **No duplicate logical Turn after lease loss:** a zombie worker plus a fresh continuation never
    produce two `turn.started` events for one request id.
12. The repair budget after an interrupted second verification is 2, not 3 (`verification.started`
    counting, `job-state.ts:99`).

**Sandbox capacity** *(one per failure boundary)*
13. 100 concurrent reservations against a cap of 10 → exactly 10 succeed. *Must be watched failing* —
    remove the advisory lock and confirm overshoot.
14. Reserve → create fails → capacity released immediately.
15. Reserve → process dies → row expires → reaper reclaims within 2 minutes.
16. Create succeeds → activation fails → reconciliation finds the unreferenced sandbox and destroys
    it.
17. Sandbox destroyed out-of-band → `active` row reconciled.
18. Per-user cap holds under concurrent admissions from one user.
19. Cluster-wide cap holds with two worker processes running against one database.

**Fanout**
20. Notify-then-read delivers every appended event exactly once to one subscriber.
21. **Cross-pod replay:** two API processes, one session → both deliver, neither duplicates.
22. **Notification loss:** `pg_notify` suppressed entirely → the catch-up poll still delivers
    everything. *Must be watched failing* — disable the poll and confirm the test goes red.
23. A rolled-back append produces no notification and no delivery.
24. Reconnect at an arbitrary `seq` mid-stream → zero gaps, zero duplicates.

**Continuation**
25. **B-1 regression:** a commit made with `turn.completed` never appended → `continuationFor(state,
    { workspaceHeadSha })` returns `kind:'verify'` against the real HEAD, not `close/unverified`.
26. `workspaceHeadSha === checkpointSha` → no spurious verification.
27. `workspaceHeadSha === null` (sandbox gone, no snapshot) → falls back to today's behaviour.

**EventSink retry**
28. A transient failure class retries and succeeds; the log contains exactly one row.
29. Three failures exhaust the budget; the sink fails stickily and the turn fails, committing nothing.
30. `23505` / `23503` / a parse failure is **never** retried.

**Cancellation**
31. Cancel from a different process aborts the executing turn within one renewal interval.
32. Cancel on a `queued` request means it is never claimed.
33. A cancelled turn commits nothing and its Job closes `abandoned`.

**Rate limits**
34. Cluster-wide limits: two API processes sharing one database enforce one allowance, not two.
35. A refused attempt records nothing, so `Retry-After` never recedes.

**Health**
36. `/livez` answers 200 with Postgres unreachable.
37. `/readyz` answers 503 with Postgres unreachable, and 503 when the LISTEN connection is down.
38. `/health` still answers 200-when-degraded with a readable body.

**Drain and scale-down**
39. SIGTERM mid-turn → the turn completes, the lease is released, the process exits before the grace
    period.
40. Drain timeout → the turn is aborted cleanly, nothing is committed, the Job closes `abandoned`.
41. Leases are renewed throughout the drain, so the janitor never orphans progressing work.

**Gates**
42. `test/architecture.ts` learns about `packages/loadgen`; nothing outside `apps/napbench` imports
    `@nap/bench`.
43. `bun run test`, `typecheck`, `lint` green; every new suite confirmed collected via
    `vitest list --project <name>`.

Tests **3, 13 and 22** are the three that must be **watched failing** before they are trusted. They
guard the three invariants that cost correctness or money if they silently pass.

---

## 23. Load test

**First benchmark is synthetic**: real HTTP, real WebSockets, real Postgres, fake `SandboxManager`,
fake `LLMProvider`, latency calibrated from `docs/napbench-first-real-run.md`.

**Headline profile:** 100 connected users, 100 WebSockets, 100 concurrent active Turns, 100 distinct
projects, burst submission.

**Secondary realism profile:** 100 connected users, ~25 active Turns with think time.

Run locally first; one deployed confirmation run after the architecture works.

**Module choice matters.** The legacy `k6/ws` blocks the VU for the socket's lifetime, so a VU cannot
hold a stream open *and* issue the HTTP POST that starts a turn. Use the async WebSocket module
(`k6/experimental/websockets`, promoted to `k6/net/websockets` in newer k6 — check the installed
version before writing the script).

**One VU = one user:**

1. `POST /api/auth/sign-in/anonymous` — the demo door (`NAP_ALLOW_DEMO=true`), the only path k6 can
   drive without OAuth, and a real code path.
2. `POST /projects` → project id, session id.
3. `GET /ws?sessionId=…&seq=0`, wait for `{"type":"ready"}`.
4. `POST /sessions/:id/turns` → expect 202.
5. Read frames until `job.completed`, recording every metric below.
6. **10% of VUs drop the socket mid-turn and reconnect** with the highest `seq` seen, asserting the
   gap arrives complete with no duplicates. This is the catch-up path and the one most likely to
   break under fanout changes.

```js
export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      gracefulRampDown: '120s',
      stages: [
        { duration: '30s', target: 10  }, { duration: '2m', target: 10  },
        { duration: '30s', target: 25  }, { duration: '2m', target: 25  },
        { duration: '30s', target: 50  }, { duration: '3m', target: 50  },
        { duration: '30s', target: 75  }, { duration: '3m', target: 75  },
        { duration: '30s', target: 100 }, { duration: '5m', target: 100 },
        { duration: '60s', target: 0   },
      ],
    },
  },
  thresholds: {
    'ws_connect_failures':                 ['count==0'],
    'event_seq_gaps':                      ['count==0'],
    'event_duplicates':                    ['count==0'],
    'turn_completion_rate':                ['rate>0.99'],
    'verification_completion_rate':        ['rate>0.99'],
    'http_req_duration{name:submit_turn}': ['p(95)<500', 'p(99)<1500'],
    'http_req_failed':                     ['rate<0.01'],
    'admission_latency':                   ['p(95)<300'],
    'queue_wait':                          ['p(95)<5000'],
    'time_to_first_event':                 ['p(95)<2000'],
    'event_delivery_latency':              ['p(95)<1000'],
    'dropped_iterations':                  ['count==0'],
  },
};
```

Custom metrics: `Trend` for admission latency, queue wait (202 → `turn.started`), time-to-first-event,
per-event inter-arrival, turn duration, verification duration, Job duration; `Counter` for seq gaps,
duplicates, WS failures, and errors by category (`rate_limited`, `sandbox_quota_exceeded`,
`byok_required`, 5xx); `Rate` for turn and verification completion.

Server-side, captured per stage and joined to the k6 output: pod CPU and memory, replica counts, DB
pool utilisation, `turn_requests` depth by state, lease renewal latency, `pg_stat_activity` counts,
and — under fakes — synthetic token counts and a *modelled* E2B/model cost, so the report carries the
column even though the run spends nothing.

**The first point of material degradation is the headline result, and the run is not a success unless
it is found.** If nothing degrades by 100 VUs, the ramp continues until something does.

---

## 24. Unresolved

Open questions that do not block starting at step 0, but must be answered before the step they name.

1. **`NAP_WORKER_CONCURRENCY`'s real value** — 5 is a guess. Step 0's baseline sets it. *(Before step
   10.)*
2. **Catch-up poll cost at 100 sessions.** 2s × 100 sessions is 50 queries/second of pure overhead if
   every session is polled independently. It should be one batched query per pod per tick, not one
   per session — measured at step 2.
3. **Whether the reaper should hold the janitor at all.** It is a third responsibility in a process
   that already has two, and its timing requirements (30s grace) are tighter than the idle sweep's
   (60s). A separate ticker inside the same pod is probably right; confirm at step 8.
   **Answered at step 8: same pod, own ticker, and not under the sweep lock.** The reasoning is in
   `apps/api/src/compose.ts` beside the janitor it decides.
4. **`hashtext` collisions.** `pg_advisory_xact_lock(hashtext(session_id))` maps uuids into int4, so
   two unrelated sessions can serialize on one lock. Contention, not corruption — noted so nobody
   "fixes" it in a panic, but worth measuring at 100 concurrent sessions in step 0.
5. **Whether `/readyz` should fail on a lost LISTEN connection or merely warn.** Failing it removes a
   pod that can still serve HTTP and can still replay from the log — the poll covers fanout. Leaning
   toward: fail, because a pod with a dead LISTEN has 2s-latency streaming and another pod does not.
   Decide at step 2.
6. **k6 authentication against a deployed cluster.** The demo door works, but a deployed confirmation
   run creates 100 anonymous users and 100 projects per run. Needs a teardown path or a test-only
   tenancy. *(Before step 11.)*
