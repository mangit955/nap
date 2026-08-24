# Scaling on a cluster: the same ramp, nine pods later

**23 August 2026.** The `docs/scaling-design.md` §23 ramp, run against a Kubernetes cluster with
both autoscalers live — three API pods, two-to-four worker pods, one reaper and an in-cluster
Postgres, KEDA on queue depth, an HPA on open sockets — and compared stage by stage against
`docs/scaling-baseline.md`, which is the same k6 script against one process. Driven by `infra/k8s/load/run.sh`. **Total spend: nothing.**
The model and the sandbox are the same fakes at the same recorded speeds; nothing left the laptop.

The point of running the same script is that the only variable is the architecture underneath.

## The headline

**Fourteen of the fifteen §23 thresholds pass at 100 concurrent turns; one does not, and the
ticket's "all thresholds pass at 100" is therefore not met.** Thirteen passed on the day. The two
that did not were the fake measuring itself — its sandboxes lived inside a worker process, so most
turns paid a synthetic cold start — and the run below on **24 August**, with that fixed, is where
the fourteenth comes from: `queue_wait` p95 fell from 5,597ms to 2,609ms and passes, and
`time_to_first_event` fell from 3,193ms to 2,596ms and still does not. See *The two thresholds that
failed, and what a shared store showed*.

What did pass is the part the split was for. At 100 VUs the cluster ran **2,310 turns with 100%
job, turn and verification completion, zero sequence gaps, zero duplicates, zero WebSocket
failures, zero 5xx, zero dropped iterations and zero rate-limit or quota refusals**, including 219
mid-turn reconnects that each asked for the gap and got exactly it. Admission and delivery both
got *faster* as load rose, and both finished faster than the single process they are compared
against.

**The workers scaled on queue depth, in both directions, and the API did not scale — correctly.**
The scale-in is the more interesting half and is described below; the API sat at 40.7 sockets a
pod against a target of 200, and below its CPU target, and was left alone. An autoscaler that does
nothing when nothing is needed is the harder half to demonstrate.

## What ran

| Profile | Stages | Duration | Turns | Result |
|---|---|---|---|---|
| `ramp` | 10 → 25 → 50 → 75 → 100 | 19m12s | 2,310 | 13 of 15 thresholds green; no degradation |
| `realism` | 100 connected, ~25 active, 75s think time | 9m48s | 501 | the same 13; the same 2 crossed |
| `smoke` | 2 → 4 | 3m0s | 15 | wiring check |

And again on 24 August, against the same cluster and the same script, with the fake's sandboxes
shared through Postgres instead of living in one worker:

| Profile | Duration | Turns | Result |
|---|---|---|---|
| `ramp` | 19m08s | 2,429 | 14 of 15; `time_to_first_event` alone crossed |
| `realism` | 9m54s | 501 | 13 of 15; both crossed, for a reason the ramp does not have |
| `smoke` | 2m44s | 15 | wiring check; too few turns for either percentile to mean anything |

One VU is one person: signed in through the demo door, one project, one session, one socket,
coming back turn after turn, with one in ten dropping the socket mid-turn and rejoining at the
highest `seq` it saw.

## Against the baseline

Ratios are candidate ÷ baseline, so **below 1 is the cluster winning**.

| VUs | admission p95 | delivery p95 | turn duration p95 | jobs |
|---:|---|---|---|---|
| 10 | 19 → 17ms (×0.90) | 34 → 31ms (×0.91) | 37.9 → 42.4s (×1.12) | 36/36 |
| 25 | 19 → 20ms (×1.05) | 35 → 27ms (×0.77) | 40.2 → 40.7s (×1.01) | 96/96 |
| 50 | 21 → 15ms (×0.71) | 36 → 22ms (×0.61) | 40.8 → 41.4s (×1.01) | 280/280 |
| 75 | 17 → 13ms (×0.79) | 33 → 19ms (×0.58) | 41.5 → 41.4s (×1.00) | 472/472 |
| 100 | 20 → 12ms (×0.60) | 40 → 17ms (×0.42) | 41.0 → 41.3s (×1.01) | 1,050/1,050 |

**Fanout got better, not worse, and that is the result worth having.** `event_delivery_latency` is
the row's own `created_at` against the client's clock, so it really is append-to-delivery. The
design replaced an in-process bus — a function call — with `pg_notify` plus a read from the log,
across a process boundary, and at 100 concurrent turns that path delivers in **17ms at p95 against
the in-process 40ms**. The reason is not that Postgres is faster than a function call; it is that
the single process was doing the fanout *and* running every turn on the same event loop, and the
cluster is not.

`admission_latency` — the route's own ownership lookup, model resolution, rate-limit and quota
queries, and the write that accepts the turn — improved for the same reason, despite now crossing
an ingress: three pods sharing 100 users each do a third of the work.

Turn duration is flat within a percent, which is the control: the fakes are the same, so it should
be, and a run where it had moved would be measuring the dice rather than the deployment.

## What the cluster was doing while that happened

| VUs | API pods | worker pods | pod CPU p50 | sockets (max) | queued (max) | leased (max) | DB conns |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 3 | 4 | 508m | 17 | 1 | 10 | 31 |
| 25 | 3 | 4 | 563m | 34 | 0 | 25 | 34 |
| 50 | 3 | 2–4 | 553m | 63 | 1 | 50 | 40 |
| 75 | 3 | 3 | 482m | 91 | 2 | 75 | 40 |
| 100 | 3 | 4 | 565m | 122 | 2 | 100 | 51 |

*(CPU is millicores across every Nap pod — nine of them at the widest point: 3 API, 4 workers, the
reaper and the in-cluster Postgres. Sockets are `nap_ws_connections` summed, read through the
custom-metrics API — the whole path an HPA uses, not a scrape that only proves the number exists.)*

Three things in that table are the acceptance criteria rather than colour.

**`leased` tracks the VU count exactly.** Ten, twenty-five, fifty, seventy-five, a hundred turns
genuinely executing at once, cluster-wide, each holding the per-session lease that makes it
exclusive. This is invariant 8 observed rather than argued.

**`queued` never exceeded 2.** The workers kept up, which is what makes a scaling decision legible
at all: depth rose, KEDA acted, depth fell back to nothing. A queue that had run away would have
made the same scaling look like the autoscaler losing.

**The workers moved, and the interesting move was downwards.** From `cluster-samples.jsonl`, the
whole of it:

| Elapsed | API | workers | leased |
|---:|---:|---:|---:|
| 0s | 3 | 4 | 2 |
| 485s | 3 | 3 | 50 |
| 490s | 3 | **2** | 50 |
| 520s | 3 | 3 | 62 |
| 745s | 3 | 4 | 100 |

The run *started* at four workers, carried over from an earlier run inside KEDA's 600-second
scale-down window — so the first thing it did was scale **in**, from four to two, in the middle of
the 50-VU plateau **with fifty turns in flight**. Then it scaled back out twice as depth rose,
reaching four again at a hundred.

That accident is better evidence than the scale-up: it is the third acceptance criterion
happening. Two workers were removed while they were running turns, and **every one of the run's
2,310 turns still completed** — the pods drained rather than being killed, because
`terminationGracePeriodSeconds` (900) comfortably exceeds `NAP_DRAIN_TIMEOUT_SECONDS` (60 here)
and a draining worker keeps renewing the leases it holds. Not one turn was orphaned, and the two
scale-ups afterwards show the trigger reading depth correctly in the other direction.

## The two thresholds that failed, and what a shared store showed

On the day, two crossed, and both were the fake measuring itself: **the in-memory sandbox lived
inside a worker process, so a turn claimed by a pod that had not seen that project before paid a
synthetic cold start** — `CALIBRATION.sandboxCreateMs`, 3,074ms — and with four workers sharing a
hundred projects that was most turns. `queue_wait` is 202-until-`turn.started` and the runtime
acquires the sandbox before it emits anything, so it carried the same three seconds on top of the
claim.

That is now fixed rather than annotated: `sharedSandboxManager` writes each fake sandbox into a
table of the run's own Postgres, so any pod reattaches to it by id, which is what a vendor-side
sandbox really does. The 24 August re-run is the same script against the same cluster.

| Threshold | Ramp 23 Aug | Ramp 24 Aug | Realism 23 Aug | Realism 24 Aug |
|---|---|---|---|---|
| `queue_wait` p95 < 5,000ms | 5,597ms | **2,609ms** ✅ | 5,819ms | 15,159ms |
| `time_to_first_event` p95 < 2,000ms | 3,193ms | 2,596ms | 3,415ms | 12,763ms |

**The one number that settles what was wrong is the cold-start count.** `sandbox_acquisition` fired
**719 times for 100 projects** on 23 August and fires **exactly 100 times** on 24 August — one per
project across 2,429 turns, which is what the single-process baseline recorded (100 across 2,415)
and what a real deployment would. Six hundred and nineteen of those seconds were the harness.

What that bought, on the ramp: `queue_wait` p95 5,597 → 2,609ms and green, its mean 1,886 → 354ms
and its p99 9,195 → 5,606ms; `time_to_first_event` p50 88 → 65ms, mean 1,137 → 253ms, p99 6,817 →
3,483ms. Nothing else moved, which is the control: admission p95 14 → 13ms, delivery p95 20 →
19ms, 2,429 turns at 100% job, turn and verification completion, zero gaps, zero duplicates, zero
5xx, and 243 reconnects each served exactly its gap.

**`time_to_first_event` is still red, and it is now red for the reason the ticket predicted.**
Per plateau it is not close to the threshold — p95 is **107–114ms at every one of 10, 25, 50, 75
and 100 VUs**, eighteen times inside it. The 2,596ms aggregate comes from the 379 turns that fall
between plateaus, where new VUs arrive and each one's *first* turn waits for a sandbox that does
not exist yet. A hundred first turns in 2,429 is 4.1%, which is all it takes to put a p95 over.
That is `docs/GOTCHAS.md`'s standing entry — `SingleAgentRuntime.runTurn` acquires the sandbox
before it emits `user.message`, so on a project's first turn nothing reaches the client until the
workspace exists, and a real cold start is no faster than the fake's. It is a finding about the
runtime rather than about the queue or the deployment, and it has its own ticket; the threshold is
not being moved to meet it.

**The realism profile got better at the median and worse at the tail, and neither is the store.**
Its `queue_wait` p50 falls **5,552 → 84ms** and `time_to_first_event` p50 **3,148 → 82ms** — the
reattach working, plainly. The tail is an initial condition: that profile starts all 100 VUs at
once, so a hundred *first* turns land together, and this time they landed on two worker pods rather
than four. `queuedRequests` peaked at **50** against 1 on 23 August, and `sandbox_acquisition` p50
doubled to 10.5s as a hundred simultaneous creations contended on one laptop node. It is the
thundering herd of a cold cluster being measured, the same class of accident as the scale-in above,
and the ramp — which is the headline profile and does not start cold — does not have it.

## The §21 invariants

Demonstrated by this run unless it says otherwise. "Covered by tests" means the free suite
asserts it and this run neither adds to nor contradicts that.

| # | Invariant | This run |
|---:|---|---|
| 1 | `seq` gapless and monotonic per session, any number of writers | **Demonstrated.** 0 gaps over 2,310 turns and 37,920 delivered frames, with up to seven Nap processes writing |
| 2 | No client sent an event not in the durable log | Covered by tests (append-then-publish is structural) |
| 3 | No client sent the same event twice | **Demonstrated.** 0 duplicates, including across 219 reconnects |
| 4 | A failed, refused or cancelled Turn commits nothing | Covered by tests; **untested here** — this run produced no failures to observe |
| 5 | Only a passing verification checkpoints a commit | **Demonstrated.** 2,310 `verification.completed` and 2,310 `job.checkpointed`, one per turn |
| 6 | Repair budget is 3 per Job, counted from the log | Covered by tests; **untested here** — nothing failed verification |
| 7 | A Job is continued only when a person opens the project | Covered by tests; **untested here** |
| 8 | At most one Turn per session, cluster-wide | **Demonstrated.** `leased` tracked the VU count exactly at every stage, never above it |
| 9 | At most one sandbox per project | **Demonstrated**, from the database rather than the report: 100 projects, 100 reservation rows, 2,310 turns. The 24 August re-run shows it in the report too — 100 `sandbox_acquisition` samples across 2,429 turns, one per project |
| 10 | A worker that lost its lease performs no further visible action | **Untested here.** No lease was lost — the scale-in above *drained*, which is the path that keeps its leases. The rolling-restart half is `infra/k8s/proof` |
| 11 | A `turn_request` is claimed at most once | **Demonstrated** transitively: 2,310 turns, 2,310 `turn.started`, no duplicate ids |
| 12 | Delivery at-least-once, logical execution at-most-once | **Demonstrated** by the same counts |
| 13 | `turn_requests.id` equals the first Turn's `turn_id` | Covered by tests |
| 14 | Every request terminal within `lease_ttl + grace` | **Demonstrated.** The queue drained to zero; nothing was left non-terminal |
| 15 | Every orphaned request has terminal events and a notice | **Untested here.** Nothing was orphaned |
| 16 | Live sandboxes never exceed `NAP_MAX_SANDBOXES_TOTAL` | **Demonstrated** at this run's ceiling of 200 — 100 reservations, 0 quota refusals. The *refusal* path is a db test |
| 17 | Capacity is reconcilable | Covered by tests; **untested here** — nothing stranded |
| 18 | An append is retried at most 3 times, never duplicating | Covered by tests; **untested here** — no transient failures occurred |
| 19 | Cancellation reaches a Turn within one renewal period | **Untested here.** The k6 journey never cancels |
| 20 | Per-user rate limits mean the same at 1 pod as at 12 | **Partially.** 0 `errors_rate_limited` against a deliberately wide allowance; the *shared* limit is a db test |
| 21 | A notification is never required for correctness | Covered by tests; **untested here** — `pg_notify` was never suppressed |
| 22 | Gates stay green; the architecture test learns any new package | Yes — `bun run test`, `typecheck`, `lint` |
| 23 | `CLAUDE.md`, `docs/DEPLOY.md`, `CONTEXT.md` describe reality | Yes |

Eight are marked untested, and all eight for the same reason: **nothing went wrong.** A load run
that produces no failures cannot demonstrate the failure paths, and the ones that matter — lease
loss, orphaning, cancellation, capacity reclamation, retry — each have a db-suite test that
provokes the failure deliberately. A run designed to break them mid-load is worth doing and is not
this run.

## Three things the run found that no manifest could

**The demo door is rate-limited per IP, and a load generator is one IP.** better-auth caps
`/sign-in*` at **3 requests per 10 seconds per address** — a default `max` does not touch it,
because that cap is a *special rule* resolved before the global one and overridden only by a
custom rule. At 100 VUs behind one ingress, ninety-seven sign-ins in ten seconds are refused, every
VU retries its whole iteration immediately, and the run reports 147,000 "iterations" and a broken
system. Two further traps sit inside the fix: the override key is a glob where `*` matches one
path segment, so `/*` matches `/sign-in` and *not* `/sign-in/anonymous`, and the whole limiter is
off under any `NODE_ENV` but `production` — so a harness that runs outside a cluster never sees it
at all. `AuthConfig.authRequestsPerWindow` is the knob; only the two fake-infrastructure
entrypoints set it. This is §24 item 6's real answer, and it applies to a deployed run too.

**A connection string shared between a pod and a cluster-scoped operator is resolved twice.**
KEDA's postgresql scaler reads `DATABASE_URL` from the same Secret the pods mount, and resolves it
from the *operator's* namespace: `nap-postgres:5432` works for every pod and answers `no such host`
for the scaler. The ScaledObject sits at `READY=False`, the workers never scale, and no pod logs
anything wrong. The load overlay fully qualifies it.

**prometheus-adapter discovers nothing for its first ten minutes.** `--metrics-relist-interval`
defaults to 10m, and until the first relist `custom.metrics.k8s.io` returns an empty resource
list — so the HPA reads `<unknown>` for `nap_ws_connections` and silently falls back to CPU, while
the scrape itself is perfectly healthy. A run that brings a cluster up and immediately starts
loading it spends its whole ramp on the fallback trigger and cannot tell.

All three are now in `docs/GOTCHAS.md`.

## What this run cannot tell you

- **Nothing about a vendor.** The sandbox and the model are fakes. What binds a real deployment at
  100 concurrent turns is E2B concurrency and model rate limits, and both are removed by design —
  the same caveat the baseline carries. `bun run acceptance` is what spends money on purpose.
- **Nothing about a node pool.** One kind node, on a laptop that is also running k6 and Docker.
  The one-minute load average sat at 2.3–3.0 throughout, so the machine was not the ceiling, but a
  cluster with real network between pods would have a different fanout latency than 17ms.
- **Nothing about failure under load**, per the invariant table above.
- **Nothing about the API's socket trigger firing.** It was *readable* — 122 sockets, through the
  full custom-metrics path — and never crossed 200, so the HPA correctly did nothing. That the
  trigger works when it does fire is asserted in `test/k8s.test.ts` and not observed here. A run
  that wanted to watch it would lower the target or raise the socket count, and would then be
  measuring a deployment nobody runs.
- **Nothing about cost.** No vendor was called. The turn count times the fake's declared usage is
  a floor of roughly 6.0M in / 254k out across the 2,310 turns of the ramp.

## Reproducing it

```bash
infra/k8s/load/run.sh                  # kind cluster, KEDA, metrics-server, Prometheus, ramp to 100
infra/k8s/load/run.sh --profile=realism
infra/k8s/load/run.sh --down
```

Roughly forty minutes for the headline profile, most of it the image build and the four pulls.
Reports, k6 summaries and the cluster samples land in `napload-results/<run-id>/`. The comparison
comes from `--baseline=napload-results/<a previous run>/report.json`, which is how the tables above
were produced; it reads two finished reports and runs nothing.

After a run against anything shared:

```bash
DATABASE_URL=… bun run loadgen:teardown --older-than-minutes=60
DATABASE_URL=… bun run loadgen:teardown --older-than-minutes=60 --confirm
```

which deletes the demo identities the run created — anonymous, older than an hour, and not holding
a queued or leased turn — along with the projects, sessions and events that cascade from them, and
destroys any sandbox they still name first. It refuses rather than leaking if there are sandboxes
to destroy and no `E2B_API_KEY` to destroy them with.

There is no default window and the destructive pass needs `--confirm`, because **this cannot tell
a load run's identity from a real visitor's and neither can the database**: age is the whole
tenancy, so against the public deployment it would delete the projects and transcripts of anybody
who came in through the demo door and has been away that long. `purgeDemoUsers` records why a
test-only tenant was rejected — the value of the demo door is that k6 goes through the real
admission path, and a load-test-only branch in it is the one path a load test would never
exercise.

Both halves were run against this cluster's database rather than argued, with the window at zero
because the run had only just finished. With 200 projects still naming a sandbox and no
`E2B_API_KEY`, it refused and deleted nothing. With those sandboxes put away — which is what the
reaper does within `NAP_REAP_IDLE_MINUTES` of a run finishing — it removed **200 identities, 200
projects and 42,338 events**, leaving the tables empty.
