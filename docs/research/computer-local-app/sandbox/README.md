# Local Docker sandbox evidence

This directory records the free local verification for the `LocalDockerSandboxManager` work on
2026-10-24. No E2B template was published, no model was called, and no paid runtime was used.

## Baseline

- `bun run test -- --maxWorkers=2` passed 425 files and 5,587 tests with no type errors before the
  implementation changed.
- Ports 3037, 3038, and 3039 each returned HTTP 200 before the work began.
- The existing `nap-local-db` container was running before the work began and is outside this
  manager's ownership.

## Test-first export guard

Command:

```text
bunx vitest run --project unit apps/api/scripts/computer-local-sandbox.test.ts --maxWorkers=1
```

Observed RED:

```text
FAIL |unit| apps/api/scripts/computer-local-sandbox.test.ts
Error: Cannot find module './computer-local-sandbox.ts'
Test Files 1 failed (1)
Tests no tests
```

The failure is the missing assigned implementation module. The test itself collected far enough to
name that import and reported no unrelated setup failure.

## Focused implementation gate

- `bunx vitest run --project unit apps/api/scripts/computer-local-sandbox.test.ts --maxWorkers=2`
  passed 10 tests. The returned sandbox id is the verified 64-hex Docker container id.
- `bunx tsc --noEmit -p apps/api/tsconfig.json` passed.
- `bunx biome check` passed for the adapter, its boundary test, and the JavaScript runtime helpers
  after applying the formatter.

## Native Docker gate

`NAP_RUN_LOCAL_DOCKER_INTEGRATION=1 bunx vitest run --project integration
apps/api/scripts/computer-local-sandbox.integration.test.ts --maxWorkers=1` passed its one opt-in test
in 518.22 seconds. The run built image `sha256:65b5cf3d…` for content digest `415d80be…` and exercised
the real template, Git, typecheck/build, both loopback bridges, production desktop operations,
concurrent cancellation, and MP4 recording. The test destroyed its exact sandbox and closed its manager.

The post-run safeguard found the original `nap-local-db` id `8d3bd782…` still running. It also found
that the baseline host listeners and PIDs for 3037/3038/3039 were no longer present. The adapter has no
host-process or fixed-port operation, so no restart or speculative attribution was made.
