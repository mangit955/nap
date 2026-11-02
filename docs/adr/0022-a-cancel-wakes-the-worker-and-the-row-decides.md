# ADR-0022 — A cancel wakes the worker, and the row decides

**Status:** Accepted, 2026-11-02. Amends `docs/scaling-design.md` §9, which sketched this and was only half delivered.

## Context

§9 designed cancellation in two parts: a durable flag, `cancel_requested`, and a `pg_notify('nap_cancel', request_id)` to get the worker's attention. Only the flag shipped. The in-process `TurnRegistry` hid the gap while one process did everything. On Render, `nap-api` and `nap-worker` are separate services, so the registry finds nothing, and a cancel waits for the worker's next lease renewal.

That wait was measured across a real API composition and a real worker composition over one Postgres. It took 14,945 ms and 14,943 ms from the cancel request to the model's abort signal. For that time the person watches a turn they stopped, and the model keeps spending.

## Decisions

### D1: The notification is a wake-up, not an abort

§9 step 4 says the owning worker "aborts its local `AbortController`". It does not. A worker that hears a cancel for a request it is running makes its ordinary conditional renewal straight away and acts on the answer, exactly as it does on the timer.

This is ADR-0010's bargain applied to cancellation: a notification is a wake-up signal and the durable row is the truth. A payload proves nothing. Every process on the database shares the channel, and a notification can be late or duplicated, or come from a replica on another version mid-rollout. Because the row decides, every bad case is cheap:

| The notification… | What happens |
|---|---|
| is lost | The next timed renewal finds the flag |
| names another worker's request | Nothing, not even a query |
| names a request that has settled | Nothing, not even a query. The entry left with the turn |
| names a request this worker is running but nobody flagged | One renewal, and the turn carries on |
| is malformed | Ignored by the adapter |

Each case has a test, and each guard was seen to fail.

### D2: It names a request, never a session

A session key finds a worker but not the turn. By the time a notification lands, that session may be running its next turn, and nobody asked to stop that one. A request is claimed at most once (§6), so its id cannot come to mean anything else.

This is also why it is a port of its own, `CancelChannel`, rather than another event on `EventBus`, which is about sessions. The in-process registry is re-keyed for the same reason.

### D3: It is sent after the commit, by the route

`pg_notify` inside `requestCancel`'s transaction would make the send atomic with the flag. We send it from the route afterwards instead, because:

- `TurnQueue` would otherwise have to know about a transport, and every implementation of it, the fake included, would have to imitate one.
- Atomic delivery buys little. The send can only be lost if the API dies between the commit and the notification, and D1 already covers a lost one.

`requestCancel` returns the request id only once the flag is committed. The route has nothing to name until then, so the order comes from the shape of the API, not from a caller's care.

### D4: It shares the event bus's listener

`PostgresCancelChannel` takes the same `PostgresNotifyTransport` as `PostgresNotifyEventBus`. postgres.js holds one socket per listening `Sql` and re-issues every channel's `LISTEN` after a reconnect, so a third channel adds no backend and needs no reconnect code. A `db` test confirms this by counting backends in `pg_stat_activity`. Sending is one statement through the pool, once per press of the stop button.

The connection budget does not change, and `NAP_LISTEN_DATABASE_URL` carries the same pooler rule as before.

**Unlike fanout, it has no catch-up read of its own.** A notification sent while the socket is down is gone. The lease renewal is the catch-up, and it was already running.

### D5: Only a worker listens

The API sends and never listens, because nothing runs in it. The worker starts listening before its first claim, so no turn runs unreachable, and stops after its drain, so a turn still draining stays reachable. A `LISTEN` that fails is logged and the worker runs on, with cancels back to arriving at renewal. A worker that cannot hear a wake-up is slower to stop a turn, which is no reason to refuse to run one.

### D6: The registry stays in the API composition

§9 says `TurnRegistry` "moves to the worker". It does not. It keeps doing one job: the single-container arrangement on the in-process bus has no listening connection, so there `cancels` is `null` and the registry is what makes a cancel immediate. Removing it would make that arrangement wait for renewal, and it would be a larger change to `turn-worker.ts` than this fix needs.

`NapDeps.cancels` is required and nullable, so a new entrypoint that forgets it fails to compile. That mistake would otherwise look like a healthy deployment with a slow stop button.

## Consequences

- **The bound in §9 is unchanged.** Cancellation reaches an executing turn within one renewal interval. The wake-up improves the typical case. It is not a new guarantee, and nothing may rely on it.
- **Measured after the fix:** p50 10 ms, p95 17 ms, max 18 ms from the cancel request to the model's abort signal, over 30 turns across two compositions and a local Postgres container. `infra/k8s/proof/run.sh` now checks the same crossing between pods, up to the terminal `turn.failed` reaching a socket on another pod, and fails above a fifth of a renewal: one run on kind took 233 ms, and 12,930 ms with the channel taken out of the pods, where the turn still ended cancelled.
- **This measures the abort signal, not the end of the turn.** How quickly a step in progress honours the signal is unchanged.
- **Nothing reports a dead listener on a worker.** A worker serves nothing, so it has no `/readyz` to fail, and a degraded listener there only shows up as a slow stop button. Every process reads the same `NAP_LISTEN_DATABASE_URL`, so the likeliest cause, a pooler, also fails the API's `listener` check.
