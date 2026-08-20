# Scaling baseline: the system before anything changed

**20 August 2026.** Five k6 runs against the composed API — one process, in-process event bus,
in-process turn registry, one Postgres — driven by `bun run loadgen:ramp`. Real HTTP, real
WebSockets, real Postgres; the sandbox and the model are fakes slowed to the speeds
`docs/napbench-first-real-run.md` recorded. **Total spend: nothing.** Nothing left the machine.

This is the "before" that `docs/scaling-design.md` §23 asks for, and the four tickets that add
queries to the admission hot path are gated on it.

## The headline, and it is a negative result

**No point of material degradation was found — not at 100 concurrent turns, and not at 1,200.**

§23 says the run is not a success unless the first point of material degradation is found, so the
ramp was extended twice: to 400, and then to 1,200. Across 1,363 seconds at up to 1,200 concurrent
turns the process served **39,183 turns with zero failures, zero sequence gaps, zero duplicates and
zero dropped iterations**, while sitting at 41% of *one* core. Latency did not rise with load; it
fell.

That is not a claim that the system scales to 1,200 users. It is a much narrower and more useful
claim: **the part of Nap that the scaling design proposes to split up — admission, the turn queue,
the event log, fanout to sockets — is nowhere near its limit at the design's target of 100.** What
binds at 100 in production is E2B sandbox concurrency and model rate limits, and the fakes remove
both by design. The case for the queue and the worker split therefore rests on vendor concurrency,
process restarts and deploy safety — not on this process running out of CPU. Anyone reading the
design as "we need workers because the API is saturated" should read this instead.

## What ran

| Profile | Stages | Duration | Turns | Result |
|---|---|---|---|---|
| `ramp` | 10 → 25 → 50 → 75 → 100 | 18m55s | 2,415 | every threshold green, no degradation |
| `extended` | … → 150 → 200 → 300 → 400 | 35m8s | 12,291 | every threshold green, no degradation |
| `saturate` | 400 → 600 → 800 → 1000 → 1200 | 22m43s | 39,183 | every threshold green, no degradation |
| `realism` | 100 connected, ~25 active, 75s think time | 9m56s | 506 | two thresholds crossed — see *cold starts* below |
| `smoke` | 2 → 4 | 3m0s | 8 | wiring check |

One VU is one person: signed in through the demo door, one project, one session, one socket,
coming back turn after turn. 10% of them drop the socket mid-turn — on `turn.started`, when there
is really something to miss — and rejoin at the highest `seq` they saw. **3,909 such reconnects in
the 1,200 run, and not one gap or duplicate.**

## Latency, by stage

`admission_latency` is the route's own work: the ownership lookup, the model-access resolution,
the rate-limit and quota queries, and the write that accepts the turn. It is the one latency a
fake-backed run measures honestly, and it is the number the four blocked tickets will move.

| VUs | admission p95 | delivery p95 | queue wait p95 | turns | CPU p50 | RSS max | pool max |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 19ms | 34ms | 44ms | 45 | 4.3% | 146MB | 2 |
| 25 | 19ms | 35ms | 42ms | 107 | 9.0% | 186MB | 3 |
| 50 | 21ms | 36ms | 52ms | 321 | 19.2% | 294MB | 4 |
| 75 | 17ms | 33ms | 46ms | 473 | 16.9% | 293MB | 6 |
| 100 | 20ms | 40ms | 56ms | 1,078 | 24.3% | 275MB | 6 |
| 400 | 14ms | 25ms | 32ms | 1,695 | 33.3% | 337MB | 10 |
| 600 | 9ms | 15ms | 24ms | 3,870 | 30.3% | 331MB | 10 |
| 800 | 5ms | 11ms | 17ms | 5,133 | 29.7% | 433MB | 10 |
| 1000 | 5ms | 10ms | 16ms | 6,405 | 34.5% | 597MB | 11 |
| 1200 | 6ms | 12ms | 19ms | 12,921 | 41.5% | 843MB | 11 |

*(10–100 from the `ramp` run, 400–1200 from `saturate`; CPU is a percentage of one core.)*

`event_delivery_latency` is the row's own `created_at` against the client's clock — append to
delivery, on one machine — so it really is fanout and not a round trip. It stayed under 40ms at
p95 throughout, and the whole-run p99 at 1,200 VUs was 23ms.

Latency *improving* under load is the JIT warming and the process spending proportionally less of
its life idle; it is not evidence of anything good. The flat line is the finding.

## The three questions §24 left open

### 1. A starting value for `NAP_WORKER_CONCURRENCY` (§24 item 1)

The design calls 5 a guess. Little's law on the measured numbers: at the 100-VU plateau the
process completed **1,078 turns in 300 seconds (3.59/s)** with a **mean turn of 25.3s**, which is
**91 turns in flight**. That is the whole of the offered load — the queue never had a backlog.

With 1.5× headroom over that:

| Workers | Recommended `NAP_WORKER_CONCURRENCY` |
|---:|---:|
| 1 | 137 |
| 2 | 69 |
| 3 | 46 |
| 4 | 35 |

**Start at 25 per worker with 4 workers.** That is deliberately *below* what this run licenses,
because this run's turns cost no CPU and no vendor quota: the concurrency a real worker can hold
is bounded by E2B sandboxes and model rate limits long before it is bounded by anything measured
here. 25 × 4 = 100 in flight, which is the design target, and the number to revise upward is this
one — with a real-vendor run behind it, not this one.

### 2. Catch-up poll cost at 100 sessions (§24 item 2)

Measured against the event log each run actually wrote, at a 2s tick:

| Sessions | Per-session poll | Batched poll |
|---:|---|---|
| 100 | 0.18ms × 50 q/s = **0.9% of one connection** | 1.87ms × 0.5 q/s = **0.09%** |
| 400 | 0.19ms × 200 q/s = **3.8%** | 9.69ms × 0.5 q/s = **0.5%** |
| 1200 | 0.21ms × 600 q/s = **12.5%** | 32.9ms × 0.5 q/s = **1.6%** |

**Both are affordable at 100; only one stays affordable.** The per-session query costs the same
whatever the session count (0.18 → 0.21ms), so the total is linear in sessions. The batched query
gets slower as it covers more (1.9 → 32.9ms), but it is paid once a tick however many there are —
which is why it wins by an order of magnitude at 1,200 and by a factor of ten already at 100.

The number that decides it is not the connection share, it is the **600 queries a second of pure
overhead** at 1,200 sessions — every one of which takes a pool slot a user's request wanted, from
a pool of 10. The design's instinct is right: **one batched query per pod per tick**. Do not poll
per session.

### 3. `hashtext` collisions (§24 item 4)

`pg_advisory_xact_lock(hashtext(session_id))` maps uuids into int4, so two unrelated sessions can
serialize on one lock. Measured on the sessions each run really created:

| Sessions | Colliding | Expected by chance |
|---:|---:|---:|
| 100 | 0 | 0.0000012 pairs |
| 400 | 0 | 0.000019 pairs |
| 1200 | 0 | 0.00017 pairs |

Then the lock itself, 500 acquisitions from 10 concurrent connections: **0.22ms each on distinct
keys, 0.18ms each on a single shared key.** Sharing a lock was, if anything, faster — the shared
key stays in cache.

**No measurable contention, and none expected.** At 1,200 sessions chance predicts one collision
in every ~6,000 runs, and a collision costs two sessions ~0.2ms of serialization. Nobody should
"fix" this in a panic, and nobody should build around it.

## Findings worth acting on

**Nothing reaches the client until the sandbox exists, and it is ~3.1s.** `SingleAgentRuntime`
acquires the sandbox *before* it emits `user.message`, so on a project's first turn the chat pane
has nothing at all for the length of a cold start. Every run shows it as the same signature: a
`time_to_first_event` p50 of 7–31ms with a p99 of ~3,100ms, and a `queue_wait` p99 of ~5,500ms —
which is exactly the calibrated create (3,074ms) plus the preview wait (2,400ms). §23's 2s
threshold on `time_to_first_event` cannot be met on a first turn however fast the queue is. This is
the one place the `realism` profile disagreed with the ramp, and only because it is 100 cold starts
spread over 506 turns rather than 39,183: its p95 lands *inside* the cold-start band (3,275ms)
instead of below it. **Emitting `user.message` before acquiring would cost nothing and would put
something on screen immediately** — worth its own ticket.

**The connection pool is the first thing that will actually run out.** It reached 10 of 10 at 400
VUs and stayed there, with database round trips still at 0.2ms — so it was saturated but not
*slow*, and nothing queued long enough to notice. It is the resource with the least headroom in
the whole picture (41% of one core, 843MB of 17GB, 4.5 of 10 load average), and it is the one the
four blocked tickets are about to add queries to. Whatever they add, measure this column again.

**Memory grows about 0.55MB per concurrent user, and most of that is the harness.** 337MB at 400
→ 843MB at 1,200. The in-memory sandbox holds every file it was written and the in-memory object
store holds every snapshot, neither of which a real deployment does. Do not size a container from
this line.

## What this run cannot tell you

- **Vendor concurrency.** No E2B, no model. This is the whole reason the process looks idle, and
  the reason the real 100-user ceiling is not in this document.
- **Anything about more than one process.** One replica, in-process bus, in-process registry.
  Cross-pod fanout, LISTEN/NOTIFY, leases and the advisory-lock admission path do not exist yet;
  the `hashtext` and poll figures above are measurements of *proposed* queries against a real,
  populated database, not of a running design.
- **Whether the load generator would break first at higher counts.** It did not here — zero
  dropped iterations, and the machine's load average never exceeded 4.5 of 10 cores — but k6 and
  the API share one laptop, and above 1,200 that stops being true.
- **A cursor that is ahead of the log.** A client rejoining at a `seq` past the end of the event
  log is *not* recorded as a gap, because `event-stream.ts` deliberately never suppresses the
  first event of a connection (a stale reconnect would otherwise be silenced forever). The gap
  counter catches lost events, which is what it is for; it does not catch a client that lied about
  where it was.
- **Anything about a deployed cluster.** §24 item 6 — 100 anonymous users and 100 projects per
  run, with no teardown path — is still open, and blocks the confirmation run against Railway.

## Reproducing it

```bash
bun run loadgen:ramp                      # §23's ramp to 100 — ~19 minutes
bun run loadgen:ramp --profile=extended   # …and on to 400 — ~37 minutes
bun run loadgen:ramp --profile=saturate   # 400 → 1200 — ~23 minutes
bun run loadgen:ramp --profile=realism    # 100 connected, ~25 active — ~10 minutes
bun run loadgen:ramp --profile=smoke      # the wiring, in three minutes
```

Needs Docker and k6 on the path; costs nothing and reaches nothing but localhost. Each run writes
`k6-summary.json`, `server-samples.jsonl` and `report.json` to `napload-results/<run-id>/`, which
is gitignored — what a run *found* belongs here, the megabytes it produced getting there do not.

The exit code is non-zero when no degradation was found, which is why every run above "failed".
That is deliberate: §23 says a run that finds nothing is not finished, and a green tick would
invite somebody to quote it as a pass.
