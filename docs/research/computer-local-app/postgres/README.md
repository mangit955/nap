# Bounded Postgres startup repair

Partial work for #149. Repairs only the Postgres startup P2 from
`/tmp/nap-local-transport-review-round1-b.md`. The parent owns launcher signal
wiring and the full integrated gate. The other P2 is outside this change.

`startDockerPostgres({ signal?, timeoutMs? })` shares one startup budget across
Docker allocation, port discovery, readiness, retries, and migrations. The
default remains 120 seconds. A unique name is registered before allocation.
Cancellation kills the owned CLI with SIGKILL and waits for close before rollback.
A CLI drain has a separate one-second bound and reports failure if it cannot drain.
SQL cancellation calls postgres.js `end({ timeout: 0 })` and drains its work.

Rollback and `stop()` have an independent five-second resource cleanup budget,
plus at most one second of process drain per interrupted CLI. Cleanup attempts
removal by the exact owned name, then requires a successful exact-name inventory
with no matching container. Missing resources succeed; surviving resources and
failed verification reject. Concurrent and repeated successful stops share one
promise; a failed stop can be retried. SQL shutdown and SQL-work drain each have
a one-second bound. These drain/cleanup allowances can extend startup rejection
beyond `timeoutMs`.

## Observed checks

- Baseline `16c2d65`: the original three `portFrom` tests passed.
- First acquisition RED: after aborting a real allocating CLI stub, the original
  helper returned `startup did not settle within test bound`, rather than
  `startup interrupted`. The test killed its own stub during teardown.
- Original startup rollback RED and four deliberate mutations failed by
  assertion. See [mutation output](mutations.txt). Each run restores source.
- Focused Vitest: 14/14 passed, including hanging run/port commands, aborts during
  readiness and migrations, shared migration deadline, rollback failure, hanging
  cleanup, exact absence verification, pre-aborted calls, default callers, and
  repeated/retryable stops.
- DB-package and full repository typecheck passed.
- Real postgres.js against an owned TCP listener that accepts but never answers
  startup passed on Node v26.12.0 and Bun 1.4.2. Node rollback took 380ms, Bun 66ms.
  Both had zero open fixture sockets after rejection. This uses a private PATH
  Docker stub and real postgres.js, with no Testcontainers allocation.

Run from the repo root:

```sh
bunx vitest run --project unit packages/db/src/testing/docker-postgres.test.ts
node docs/research/computer-local-app/postgres/mutate.mjs
node docs/research/computer-local-app/postgres/native-fault.mjs
bun docs/research/computer-local-app/postgres/native-fault.mjs
bun run typecheck
```

## Limits

No real Docker allocations, existing databases, running app processes, reserved
ports, paid services, or full integration suite were used. The native fault test
binds only an owned ephemeral loopback port. Successful SQL migrations and stalled
migration cancellation are covered at the library boundary, not against a native
Postgres container. Docker daemon behavior after a killed client, including a
server-side request that completes after the exact-name absence check, is not
proved by the process stub. Cleanup reports unavailable or unverifiable Docker
state; it cannot guarantee daemon behavior after the check.
